import { withRequestTimeout } from './apiRequestTimeout.js';

type ApiJson = <T>(path: string, options?: RequestInit) => Promise<T>;

const TIMEOUT_MESSAGE = 'Starting FairPlay credential retrieval timed out. Refresh status before trying again; the iPad task may already have started.';
export const OFFLINE_APP_STORE_CREDENTIAL_RETRIEVAL_REQUEST_TIMEOUT_MS = 15_000;

export function retrieveOfflineAppStoreCredentialRequest<T>(
  apiJson: ApiJson,
  deviceId: string,
  timeoutMs = OFFLINE_APP_STORE_CREDENTIAL_RETRIEVAL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  return withRequestTimeout(
    (signal) => apiJson<T>('/v1/dashboard/appstore-offline/credential/retrieve', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
      signal,
    }),
    timeoutMs,
    TIMEOUT_MESSAGE,
  );
}
