import { withRequestTimeout } from './apiRequestTimeout.js';

type ApiJson = <T>(path: string, opts?: RequestInit) => Promise<T>;

const TIMEOUT_MESSAGE = 'Saving Apple Account details timed out. Refresh status before trying again; the save may have completed.';

export function saveOfflineAppStoreAccountRequest<T>(
  apiJson: ApiJson,
  appleId: string,
  password: string,
  timeoutMs = 30_000,
): Promise<T> {
  return withRequestTimeout(
    (signal) => apiJson<T>('/v1/dashboard/appstore-offline/account', {
      method: 'PUT',
      body: JSON.stringify({ appleId, password }),
      signal,
    }),
    timeoutMs,
    TIMEOUT_MESSAGE,
  );
}
