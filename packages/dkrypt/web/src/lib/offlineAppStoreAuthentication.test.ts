import { expect, test } from 'bun:test';
import { authenticateOfflineAppStoreAccountRequest, OFFLINE_APP_STORE_AUTHENTICATION_TIMEOUT_MS } from './offlineAppStoreAuthentication';

test('Apple Account verification only waits for the short background-operation start response', () => {
  expect(OFFLINE_APP_STORE_AUTHENTICATION_TIMEOUT_MS).toBe(10_000);
});

test('Apple Account verification aborts a request that never settles and reports a timeout', async () => {
  let aborted = false;
  const result = await authenticateOfflineAppStoreAccountRequest(
    <T>(_path: string, options?: RequestInit) => new Promise<T>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        aborted = true;
        reject(options.signal?.reason);
      }, { once: true });
    }),
    undefined,
    10,
  ).then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error));

  expect(aborted).toBe(true);
  expect(result).toBe('Could not start Apple Account verification. Refresh status before trying again.');
});

test('Apple Account verification sends the optional one-time code through the authenticated API', async () => {
  let captured: { path: string; options?: RequestInit } | undefined;
  const result = await authenticateOfflineAppStoreAccountRequest(
    async <T>(path: string, options?: RequestInit) => {
      captured = { path, options };
      return { verified: true } as T;
    },
    '123456',
    100,
  );

  expect(result).toEqual({ verified: true });
  expect(captured?.path).toBe('/v1/dashboard/appstore-offline/authenticate');
  expect(captured?.options?.method).toBe('POST');
  expect(JSON.parse(String(captured?.options?.body))).toEqual({ verificationCode: '123456' });
  expect(captured?.options?.signal?.aborted).toBe(false);
});

test('Apple Account verification can retry saved credentials without submitting a code', async () => {
  let captured: { path: string; options?: RequestInit } | undefined;
  await authenticateOfflineAppStoreAccountRequest(
    async <T>(path: string, options?: RequestInit) => {
      captured = { path, options };
      return { verified: true } as T;
    },
    undefined,
    100,
    true,
  );

  expect(captured?.path).toBe('/v1/dashboard/appstore-offline/authenticate');
  expect(JSON.parse(String(captured?.options?.body))).toEqual({ retrySavedCredentials: true });
});
