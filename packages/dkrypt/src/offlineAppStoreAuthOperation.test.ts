import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAppleAccountAuthenticationOperation } from '#offlineAppStoreAuthOperation.js';
import { createOfflineAppStoreAuthenticationRepository } from '#store/offlineAppStoreAuthenticationRepository.js';
import { openStateCollectionDatabase } from '#store/sqlite.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createRepository() {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'dkrypt-apple-auth-'));
  directories.push(stateDir);
  const database = openStateCollectionDatabase({ stateDir, filename: 'state.sqlite' }, ['appstore_offline_authentication_operations']);
  return { database, repository: createOfflineAppStoreAuthenticationRepository(database) };
}

test('Apple Account verification runs in the background and supports a one-time code without persisting it', async () => {
  const { database, repository } = createRepository();
  const submittedCodes: Array<string | undefined> = [];
  let statusChangeCount = 0;
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: async (code) => {
      submittedCodes.push(code);
      if (!code) throw Object.assign(new Error('code required'), { code: 'two_factor_required' });
    },
    repository,
    timeoutMs: 1000,
    onStatusChanged: () => { statusChangeCount += 1; },
  });

  try {
    expect(operation.start()).toMatchObject({ state: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operation.status()).toMatchObject({ state: 'verification_required' });
    expect(operation.start()).toEqual(operation.status());
    expect(operation.start('123456')).toMatchObject({ state: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(operation.status()).toMatchObject({ state: 'succeeded' });
    expect(submittedCodes).toEqual([undefined, '123456']);
    expect(statusChangeCount).toBe(4);
    const stored = database.query('SELECT payload FROM appstore_offline_authentication_operations').get() as { payload: string };
    expect(stored.payload).not.toContain('123456');
  } finally {
    database.close();
  }
});

test('Apple Account verification has a bounded timeout even if the provider ignores cancellation', async () => {
  const { database, repository } = createRepository();
  let signal: AbortSignal | undefined;
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: ((_code?: string, receivedSignal?: AbortSignal) => {
      signal = receivedSignal;
      return new Promise<void>(() => {});
    }),
    repository,
    timeoutMs: 10,
  });

  try {
    operation.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(signal?.aborted).toBe(true);
    expect(operation.status()).toMatchObject({ state: 'failed', error: 'Apple Account verification timed out. Check Apple Account status before trying again.' });
  } finally {
    database.close();
  }
});

test('Apple Account verification records providers that throw before returning a promise', async () => {
  const { database, repository } = createRepository();
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: () => { throw new Error('provider unavailable'); },
    repository,
    timeoutMs: 1000,
  });

  try {
    expect(operation.start()).toMatchObject({ state: 'running' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operation.status()).toMatchObject({ state: 'failed', error: 'Apple Account authentication failed. Confirm the saved credentials and try again.' });
  } finally {
    database.close();
  }
});

test('Apple Account verification can retry saved credentials without a code after an ambiguous rejection', async () => {
  const { database, repository } = createRepository();
  let attempts = 0;
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: async () => {
      attempts += 1;
      throw Object.assign(new Error('ambiguous Apple rejection'), { code: 'two_factor_required' });
    },
    repository,
    timeoutMs: 1000,
  });

  try {
    operation.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operation.status().state).toBe('verification_required');
    expect(operation.start()).toEqual(operation.status());
    expect(operation.start(undefined, true).state).toBe('running');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts).toBe(2);
    expect(operation.status().state).toBe('verification_required');
  } finally {
    database.close();
  }
});

test('Apple Account verification replaces a persisted definite-code message with the safe ambiguous explanation', () => {
  const { database, repository } = createRepository();
  repository.write({ state: 'verification_required', operationId: 'operation-legacy', startedAt: 1, completedAt: 2, error: 'Apple requires a six-digit verification code. Check the trusted device.' });
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: async () => {},
    repository,
    timeoutMs: 1000,
  });

  try {
    expect(operation.status().error).toContain('password may be incorrect');
    expect((database.query('SELECT payload FROM appstore_offline_authentication_operations').get() as { payload: string }).payload)
      .toContain('password may be incorrect');
  } finally {
    database.close();
  }
});

test('Apple Account verification preserves a safe provider failure category', async () => {
  const { database, repository } = createRepository();
  const operation = createAppleAccountAuthenticationOperation({
    authenticate: async () => { throw Object.assign(new Error('provider rejected login'), { code: 'invalid_credentials' }); },
    repository,
    timeoutMs: 1000,
  });

  try {
    operation.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(operation.status()).toMatchObject({
      state: 'failed',
      error: 'Apple rejected the saved credentials. Check the Apple Account email and password.',
    });
    expect(operation.status().error).not.toContain('provider rejected login');
  } finally {
    database.close();
  }
});

test('interrupted Apple Account verification is recoverable after server restart', () => {
  const { database, repository } = createRepository();
  repository.write({ state: 'running', operationId: 'operation-1', startedAt: 123 });
  database.close();

  const restartedDatabase = openStateCollectionDatabase({ stateDir: directories.at(-1)!, filename: 'state.sqlite' }, ['appstore_offline_authentication_operations']);
  const restarted = createAppleAccountAuthenticationOperation({
    authenticate: async () => {},
    repository: createOfflineAppStoreAuthenticationRepository(restartedDatabase),
    timeoutMs: 1000,
  });

  try {
    expect(restarted.status()).toMatchObject({ state: 'interrupted', error: 'The server restarted during Apple Account verification. Start again.' });
  } finally {
    restartedDatabase.close();
  }
});
