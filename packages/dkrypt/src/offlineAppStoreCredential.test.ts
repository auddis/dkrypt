import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppleAccountVault } from '#appleAccountVault.js';
import { createAppleAccountRepository } from '#store/appleAccountRepository.js';
import { createOfflineCredentialRetrievalRepository } from '#store/offlineCredentialRetrievalRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createFairPlayCredentialRetriever, sshWrapper } from '#offlineAppStoreCredential.js';
import type { DeviceRecord } from '#store/state.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('credential SSH wrapper converts upstream root access to the paired mobile account', () => {
  const wrapperRoot = mkdtempSync(path.join(tmpdir(), 'dkrypt-fairplay-ssh-wrapper-'));
  directories.push(wrapperRoot);
  const wrapperPath = path.join(wrapperRoot, 'ssh');
  const fakeSshPath = path.join(wrapperRoot, 'fake-ssh');
  writeFileSync(fakeSshPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  writeFileSync(wrapperPath, sshWrapper().replace('/usr/bin/ssh', fakeSshPath), { mode: 0o700 });

  const result = spawnSync(wrapperPath, [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=8',
    '-p', '2222',
    'root@127.0.0.1',
    'if command -v jbroot >/dev/null 2>&1; then jbroot /var/tmp; fi',
  ], {
    encoding: 'utf8',
    env: { ...process.env, DKRYPT_DEVICE_SSH_KEY: '/tmp/device-key' },
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toContain('mobile@127.0.0.1');
  expect(result.stdout).toContain('UserKnownHostsFile=/dev/null');
  expect(result.stdout).toContain('sudo -n env PATH=/var/jb/usr/bin:/var/jb/bin:/usr/bin:/bin:/sbin sh -c');
  expect(result.stdout).not.toContain('root@127.0.0.1');
});

test('credential retrieval targets the requested paired USB iPad, drains it, and stores bytes through the encrypted vault', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-device-credential-'));
  directories.push(stateDir);
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_account', 'appstore_offline_credential_operations']);
  const vault = createAppleAccountVault(createAppleAccountRepository(database), Buffer.alloc(32, 6).toString('base64url'));
  const operationRepository = createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_credential_operations']));
  vault.saveAccount('admin@icloud.com', 'account-password');
  vault.markAuthenticated(1234);
  let device: DeviceRecord = {
    id: 'selected-ipad',
    name: 'Selected iPad',
    transport: 'usb',
    udid: 'a'.repeat(40),
    productType: 'iPad14,3',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const otherDevice: DeviceRecord = {
    id: 'other-ipad',
    name: 'Other iPad',
    transport: 'usb',
    udid: 'e'.repeat(40),
    productType: 'iPad14,3',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const received: string[] = [];
  const retriever = createFairPlayCredentialRetriever({
    getDevice: (id) => id === device.id ? device : id === otherDevice.id ? otherDevice : undefined,
    getActiveJobs: () => [],
    getVaultStatus: vault.status,
    updateDevice: (id, patch) => {
      if (id !== device.id) return { ok: false, error: 'device not found' };
      device = { ...device, ...patch };
      return { ok: true, device };
    },
    saveCredential: (value) => {
      received.push(value);
      return vault.saveCredential(value);
    },
    runRetriever: async (selected) => {
      expect(selected.id).toBe('selected-ipad');
      expect(device.draining).toBe(true);
      return Buffer.alloc(16, 11);
    },
    operationRepository,
  });

  try {
    const started = retriever.start('selected-ipad');
    expect(started).toMatchObject({ state: 'running', deviceId: 'selected-ipad' });
    expect(retriever.start('selected-ipad').operationId).toBe(started.operationId);
    for (let attempt = 0; attempt < 50 && retriever.status().state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(retriever.status()).toMatchObject({ state: 'succeeded', deviceId: 'selected-ipad' });
    expect(device.draining).toBe(false);
    expect(otherDevice.draining).toBeUndefined();
    expect(otherDevice.enabled).toBe(true);
    expect(vault.status().credentialConfigured).toBe(true);
    expect(Buffer.from(received[0]!, 'base64')).toEqual(Buffer.alloc(16, 11));
  } finally {
    operationRepository.close();
    vault.close();
  }
});

test('failed credential retrieval retains a redacted helper diagnostic and releases the iPad', async () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-device-credential-diagnostic-'));
  directories.push(stateDir);
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_account', 'appstore_offline_credential_operations']);
  const vault = createAppleAccountVault(createAppleAccountRepository(database), Buffer.alloc(32, 7).toString('base64url'));
  const operationRepository = createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_credential_operations']));
  vault.saveAccount('admin@icloud.com', 'account-password');
  vault.markAuthenticated(1234);
  const fairPlayCredential = Buffer.alloc(16, 0x7b);
  let device: DeviceRecord = {
    id: 'diagnostic-ipad',
    name: 'Diagnostic iPad',
    transport: 'usb',
    udid: 'd'.repeat(40),
    productType: 'iPad14,3',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const retriever = createFairPlayCredentialRetriever({
    getDevice: (id) => id === device.id ? device : undefined,
    getActiveJobs: () => [],
    getVaultStatus: vault.status,
    getSecrets: vault.read,
    updateDevice: (id, patch) => {
      if (id !== device.id) return { ok: false, error: 'device not found' };
      device = { ...device, ...patch };
      return { ok: true, device };
    },
    saveCredential: vault.saveCredential,
    runRetriever: async () => {
      throw new Error(`device command failed: no installed App Store app for admin@icloud.com password=account-password credential=${fairPlayCredential.toString('base64')} credentialHex=0x${fairPlayCredential.toString('hex')} on 00008030-001624583AF9402E at /var/containers/Bundle/Application/12345678-1234-1234-1234-123456789abc/Example.app/${'a'.repeat(40)} helper=/opt/fairplay-decrypt/credential-retrieval/retrieve.py key=/run/secrets/id_ed25519`);
    },
    operationRepository,
  });

  try {
    retriever.start(device.id);
    for (let attempt = 0; attempt < 50 && retriever.status().state === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const status = retriever.status();
    expect(status.state).toBe('failed');
    expect(status.error).toContain('no installed App Store app');
    expect(status.error).not.toContain('admin@icloud.com');
    expect(status.error).not.toContain('00008030-001624583AF9402E');
    expect(status.error).not.toContain('/var/containers/Bundle/Application');
    expect(status.error).not.toContain('Example.app');
    expect(status.error).not.toContain('12345678-1234-1234-1234-123456789abc');
    expect(status.error).not.toContain('a'.repeat(40));
    expect(status.error).not.toContain('account-password');
    expect(status.error).not.toContain(fairPlayCredential.toString('base64'));
    expect(status.error).not.toContain(fairPlayCredential.toString('hex'));
    expect(status.error).not.toContain('/opt/fairplay-decrypt');
    expect(status.error).not.toContain('/run/secrets/id_ed25519');
    expect(operationRepository.read()?.error).toBe(status.error);
    expect(device.draining).toBe(false);
  } finally {
    operationRepository.close();
    vault.close();
  }
});

test('credential retrieval rejects devices that are not the exact enabled USB iPad or when a job is running', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-device-credential-validation-'));
  directories.push(stateDir);
  const valid: DeviceRecord = {
    id: 'ipad',
    name: 'iPad',
    transport: 'usb',
    udid: 'b'.repeat(40),
    productType: 'iPad14,3',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const operationRepository = createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_credential_operations']));
  const base = {
    getDevice: (id: string) => id === valid.id ? valid : undefined,
    getActiveJobs: () => [],
    getVaultStatus: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: false, authenticatedAt: 1 }),
    updateDevice: () => ({ ok: true, device: valid }),
    saveCredential: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: true }),
    runRetriever: async () => Buffer.alloc(16),
    operationRepository,
  };

  try {
    expect(() => createFairPlayCredentialRetriever(base).start('unknown')).toThrow('enabled, paired USB iPad');
    expect(() => createFairPlayCredentialRetriever({
      ...base,
      getActiveJobs: () => [{ id: 'job', status: 'running', deviceId: valid.id } as never],
    }).start(valid.id)).toThrow('currently running a job');
  } finally {
    operationRepository.close();
  }
});

test('an in-progress retrieval survives restart as interrupted without automatically re-enabling its iPad', () => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-device-credential-restart-'));
  directories.push(stateDir);
  let device: DeviceRecord = {
    id: 'restart-ipad',
    name: 'Restart iPad',
    transport: 'usb',
    udid: 'c'.repeat(40),
    productType: 'iPad14,3',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  };
  const firstRepository = createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_credential_operations']));
  const firstRetriever = createFairPlayCredentialRetriever({
    getDevice: (id) => id === device.id ? device : undefined,
    getActiveJobs: () => [],
    getVaultStatus: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: false, authenticatedAt: 1 }),
    updateDevice: (id, patch) => {
      if (id !== device.id) return { ok: false, error: 'device not found' };
      device = { ...device, ...patch, updatedAt: device.updatedAt + 1 };
      return { ok: true, device };
    },
    saveCredential: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: true }),
    runRetriever: async () => new Promise<Buffer>(() => {}),
    operationRepository: firstRepository,
  });

  expect(firstRetriever.start(device.id).state).toBe('running');
  firstRepository.close();

  const secondRepository = createOfflineCredentialRetrievalRepository(openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_credential_operations']));
  const secondRetriever = createFairPlayCredentialRetriever({
    getDevice: (id) => id === device.id ? device : undefined,
    getActiveJobs: () => [],
    getVaultStatus: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: false, authenticatedAt: 1 }),
    updateDevice: () => ({ ok: true, device }),
    saveCredential: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: true }),
    runRetriever: async () => Buffer.alloc(16),
    operationRepository: secondRepository,
  });

  try {
    expect(secondRetriever.status()).toMatchObject({ state: 'interrupted', deviceId: device.id });
    expect(secondRetriever.status().error).toContain('remains paused');
    expect(device.draining).toBe(true);
  } finally {
    secondRepository.close();
  }
});
