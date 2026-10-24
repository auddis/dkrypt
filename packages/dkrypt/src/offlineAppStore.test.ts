import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppleAccountVault } from '#appleAccountVault.js';
import { createAppleAccountRepository } from '#store/appleAccountRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';
import { createOfflineAppStoreProcessor, OfflineAppStoreUnavailableError, type OfflineAppStoreDependencies } from '#offlineAppStore.js';
import type { AppleAccountSecrets } from '#appleAccountVault.js';
import type { Job } from '#jobs/types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDependencies(overrides: Partial<OfflineAppStoreDependencies> = {}): Promise<OfflineAppStoreDependencies> {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-offline-appstore-'));
  directories.push(root);
  const executables = await Promise.all(['dkrypt-appstore-downloader', 'fairplay-decrypt'].map(async (name) => {
    const executable = path.join(root, name);
    await writeFile(executable, '');
    await chmod(executable, 0o700);
    return executable;
  }));
  const secrets: AppleAccountSecrets = {
    appleId: 'test@example.test',
    password: 'account-password',
    fairPlayCredential: Buffer.alloc(16, 4).toString('base64'),
  };
  return {
    enabled: true,
    fairPlayAuthorized: true,
    downloaderPath: executables[0]!,
    decryptorPath: executables[1]!,
    stagingDirectory: path.join(root, 'staging'),
    getSecrets: () => secrets,
    getVaultStatus: () => ({ encryptionReady: true, accountConfigured: true, credentialConfigured: true, authenticatedAt: 1 }),
    async runDownload(_job, _account, outputPath) {
      await writeFile(outputPath, 'encrypted ipa');
    },
    async runDecrypt(_job, _account, _inputPath, outputPath) {
      await writeFile(outputPath, 'decrypted ipa');
    },
    inspect: async () => ({
      verification: { encryptedPaths: [], primaryExecutable: 'Payload/App.app/App', primaryEncrypted: false, extensionOnly: false },
      metadata: { summary: { shortVersion: '1.0' }, infoPlist: { CFBundleIdentifier: 'com.example.app', CFBundleShortVersionString: '1.0' } },
    }),
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'offline-job',
    bundleId: 'com.example.app',
    source: 'manual',
    status: 'running',
    priority: 0,
    progress: 'processing',
    createdAt: Date.now(),
    waiters: [],
    ...overrides,
  };
}

test('offline App Store processing remains unavailable until explicitly enabled and authorized', async () => {
  const dependencies = await createDependencies({ enabled: false });
  const processor = createOfflineAppStoreProcessor(dependencies);
  expect(processor.readiness()).toMatchObject({ enabled: false, ready: false, fairPlayAuthorized: true });
  await expect(processor.run(job())).rejects.toBeInstanceOf(OfflineAppStoreUnavailableError);

  const unauthorized = createOfflineAppStoreProcessor({ ...dependencies, enabled: true, fairPlayAuthorized: false });
  expect(unauthorized.readiness().blockers).toContain('FairPlay decryptor use has not been approved');
});

test('offline App Store processor excludes TestFlight and verifies a decrypted package before returning it', async () => {
  const dependencies = await createDependencies();
  const processor = createOfflineAppStoreProcessor(dependencies);
  expect(processor.readiness({ testflight: {} as NonNullable<Job['testflight']> })).toMatchObject({ ready: false, blockers: ['TestFlight stays on the device workflow'] });
  const currentJob = job();
  const result = await processor.run(currentJob);
  expect(result.outputPath).toContain('offline-decrypted.ipa');
  expect(result.warnings).toEqual([]);
  expect(currentJob.warnings).toBeUndefined();
});

test('offline App Store processor reports the decrypt stage after download validation', async () => {
  const stages: string[] = [];
  const processor = createOfflineAppStoreProcessor(await createDependencies());
  await processor.run(job(), undefined, (stage) => stages.push(stage));
  expect(stages).toEqual(['offline_decrypting']);
});

test('offline App Store processor preserves extension-only warnings and removes encrypted staging data', async () => {
  const dependencies = await createDependencies({
    inspect: async () => ({
      verification: { encryptedPaths: ['Payload/App.app/PlugIns/Share.appex/Share'], primaryExecutable: 'Payload/App.app/App', primaryEncrypted: false, extensionOnly: true },
      metadata: { summary: { shortVersion: '1.0' }, infoPlist: { CFBundleIdentifier: 'com.example.app', CFBundleShortVersionString: '1.0' } },
    }),
  });
  const result = await createOfflineAppStoreProcessor(dependencies).run(job());
  expect(result.warnings[0]).toContain('Some embedded extensions remained encrypted');
  expect(await Bun.file(path.join(dependencies.stagingDirectory, 'offline-job.offline-encrypted.ipa')).exists()).toBe(false);
  expect(await Bun.file(result.outputPath).exists()).toBe(true);
});

test('offline App Store processor removes both staged files on decrypt and verification failures', async () => {
  const dependencies = await createDependencies({ runDecrypt: async () => { throw new Error('decrypt failed'); } });
  await expect(createOfflineAppStoreProcessor(dependencies).run(job())).rejects.toThrow('decrypt failed');
  expect(await Bun.file(path.join(dependencies.stagingDirectory, 'offline-job.offline-encrypted.ipa')).exists()).toBe(false);
  expect(await Bun.file(path.join(dependencies.stagingDirectory, 'offline-job.offline-decrypted.ipa')).exists()).toBe(false);

  const encryptedPrimary = await createDependencies({
    inspect: async () => ({
      verification: { encryptedPaths: ['Payload/App.app/App'], primaryExecutable: 'Payload/App.app/App', primaryEncrypted: true, extensionOnly: false },
      metadata: { summary: { shortVersion: '1.0' }, infoPlist: { CFBundleIdentifier: 'com.example.app', CFBundleShortVersionString: '1.0' } },
    }),
  });
  await expect(createOfflineAppStoreProcessor(encryptedPrimary).run(job())).rejects.toThrow('FairPlay verification found encrypted executable paths');
  expect(await Bun.file(path.join(encryptedPrimary.stagingDirectory, 'offline-job.offline-encrypted.ipa')).exists()).toBe(false);
  expect(await Bun.file(path.join(encryptedPrimary.stagingDirectory, 'offline-job.offline-decrypted.ipa')).exists()).toBe(false);
});

test('offline App Store processor rejects a package for another app or release', async () => {
  const wrongBundle = await createDependencies({
    inspect: async () => ({
      verification: { encryptedPaths: [], primaryExecutable: 'Payload/App.app/App', primaryEncrypted: false, extensionOnly: false },
      metadata: { summary: { shortVersion: '1.0' }, infoPlist: { CFBundleIdentifier: 'com.other.app', CFBundleShortVersionString: '1.0' } },
    }),
  });
  await expect(createOfflineAppStoreProcessor(wrongBundle).run(job())).rejects.toThrow('does not match requested com.example.app');

  const wrongVersion = await createDependencies();
  await expect(createOfflineAppStoreProcessor(wrongVersion).run(job({ versionLabel: '2.0', externalVersionId: 'version-2' }))).rejects.toThrow('does not match requested 2.0');
});

test('offline decryption receives the account credential only from the encrypted vault', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dkrypt-offline-vault-'));
  directories.push(root);
  const database = openStateCollectionDatabase({ stateDir: root, filename: 'state.sqlite' }, ['appstore_offline_account']);
  const vault = createAppleAccountVault(createAppleAccountRepository(database), Buffer.alloc(32, 18).toString('base64url'));
  const credential = Buffer.alloc(16, 12).toString('base64');
  vault.saveAccount('account@example.test', 'account-password');
  vault.saveCredential(credential);
  vault.markAuthenticated(1);
  let receivedCredential: string | undefined;

  try {
    const dependencies = await createDependencies({
      getSecrets: vault.read,
      getVaultStatus: vault.status,
      async runDecrypt(_job, secrets, _inputPath, outputPath) {
        receivedCredential = secrets.fairPlayCredential;
        await writeFile(outputPath, 'decrypted ipa');
      },
    });
    await createOfflineAppStoreProcessor(dependencies).run(job());
    expect(receivedCredential).toBe(credential);
  } finally {
    vault.close();
  }
});
