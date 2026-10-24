import { withRequestTimeout } from './apiRequestTimeout.js';

type ApiJson = <T>(path: string, options?: RequestInit) => Promise<T>;

const TIMEOUT_MESSAGE = 'Could not start Apple Account verification. Refresh status before trying again.';
export const OFFLINE_APP_STORE_AUTHENTICATION_TIMEOUT_MS = 10_000;

export function authenticateOfflineAppStoreAccountRequest<T>(
  apiJson: ApiJson,
  verificationCode?: string,
  timeoutMs = OFFLINE_APP_STORE_AUTHENTICATION_TIMEOUT_MS,
): Promise<T> {
  return withRequestTimeout(
    (signal) => apiJson<T>('/v1/dashboard/appstore-offline/authenticate', {
      method: 'POST',
      body: JSON.stringify(verificationCode ? { verificationCode } : {}),
      signal,
    }),
    timeoutMs,
    TIMEOUT_MESSAGE,
  );
}
