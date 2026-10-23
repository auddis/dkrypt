import { expect, test } from 'bun:test';
import { saveOfflineAppStoreAccountRequest } from './offlineAppStoreAccountSave';

test('aborts an Apple Account save that does not return and explains how to check its result', async () => {
  const result = await saveOfflineAppStoreAccountRequest(
    <T>(_path: string, options?: RequestInit) => new Promise<T>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
    }),
    'probe@example.invalid',
    'dummy-probe-only',
    10,
  ).then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error));

  expect(result).toBe('Saving Apple Account details timed out. Refresh status before trying again; the save may have completed.');
});

test('sends the Apple Account save as an idempotent bounded PUT request', async () => {
  let captured: { path: string; options?: RequestInit } | undefined;
  const result = await saveOfflineAppStoreAccountRequest(
    async <T>(path: string, options?: RequestInit) => {
      captured = { path, options };
      return { saved: true } as T;
    },
    'probe@example.invalid',
    'dummy-probe-only',
    100,
  );

  expect(result).toEqual({ saved: true });
  expect(captured?.path).toBe('/v1/dashboard/appstore-offline/account');
  expect(captured?.options?.method).toBe('PUT');
  expect(JSON.parse(String(captured?.options?.body))).toEqual({ appleId: 'probe@example.invalid', password: 'dummy-probe-only' });
  expect(captured?.options?.signal?.aborted).toBe(false);
});
