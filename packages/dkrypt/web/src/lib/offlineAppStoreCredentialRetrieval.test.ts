import { expect, test } from 'bun:test';
import { OFFLINE_APP_STORE_CREDENTIAL_RETRIEVAL_REQUEST_TIMEOUT_MS, retrieveOfflineAppStoreCredentialRequest } from './offlineAppStoreCredentialRetrieval';

test('FairPlay retrieval start has a bounded dashboard request', () => {
  expect(OFFLINE_APP_STORE_CREDENTIAL_RETRIEVAL_REQUEST_TIMEOUT_MS).toBe(15_000);
});

test('FairPlay retrieval start aborts a request that never responds with a useful status-check instruction', async () => {
  let aborted = false;
  const result = await retrieveOfflineAppStoreCredentialRequest(
    <T>(_path: string, options?: RequestInit) => new Promise<T>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(options.signal?.reason);
      }, { once: true });
    }),
    'selected-ipad',
    10,
  ).then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error));

  expect(aborted).toBe(true);
  expect(result).toBe('Starting FairPlay credential retrieval timed out. Refresh status before trying again; the iPad task may already have started.');
});

test('FairPlay retrieval start posts only the selected device ID', async () => {
  let captured: { path: string; options?: RequestInit } | undefined;
  const result = await retrieveOfflineAppStoreCredentialRequest(
    async <T>(path: string, options?: RequestInit) => {
      captured = { path, options };
      return { state: 'running' } as T;
    },
    'selected-ipad',
    100,
  );

  expect(result).toEqual({ state: 'running' });
  expect(captured?.path).toBe('/v1/dashboard/appstore-offline/credential/retrieve');
  expect(captured?.options?.method).toBe('POST');
  expect(JSON.parse(String(captured?.options?.body))).toEqual({ deviceId: 'selected-ipad' });
  expect(captured?.options?.signal?.aborted).toBe(false);
});
