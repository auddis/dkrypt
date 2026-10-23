import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppleAccountVault } from '#appleAccountVault.js';
import { createAppleAccountRepository } from '#store/appleAccountRepository.js';
import { createOfflineCredentialRetrievalRepository } from '#store/offlineCredentialRetrievalRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createFairPlayCredentialRetriever } from '#offlineAppStoreCredential.js';
import type { DeviceRecord } from '#store/state.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
  const received: string[] = [];
  const retriever = createFairPlayCredentialRetriever({
    getDevice: (id) => id === device.id ? device : undefined,
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
    expect(vault.status().credentialConfigured).toBe(true);
    expect(Buffer.from(received[0]!, 'base64')).toEqual(Buffer.alloc(16, 11));
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
