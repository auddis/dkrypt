import { randomUUID } from 'node:crypto';
import { log } from '#logger.js';
import type { OfflineAppStoreAuthenticationRepository } from '#store/offlineAppStoreAuthenticationRepository.js';

export type AppleAccountAuthenticationState = 'idle' | 'running' | 'verification_required' | 'succeeded' | 'failed' | 'interrupted';

export interface AppleAccountAuthenticationStatus {
  state: AppleAccountAuthenticationState;
  operationId?: string;
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface AppleAccountAuthenticationDependencies {
  authenticate(verificationCode?: string, signal?: AbortSignal): Promise<void>;
  repository: OfflineAppStoreAuthenticationRepository;
  timeoutMs: number;
  now?: () => number;
  onStatusChanged?: () => void;
}

const AUTHENTICATION_TIMEOUT_MESSAGE = 'Apple Account verification timed out. Check Apple Account status before trying again.';
const APPLE_TWO_FACTOR_REQUIRED = 'Apple rejected sign-in. The password may be incorrect, or Apple may require a verification code. Confirm the saved password and check the trusted iPad; submit a code only if Apple shows one.';
const APPLE_VERIFICATION_CODE_REJECTED = 'Apple rejected sign-in with that code. Confirm the saved password and request a fresh code only if Apple is showing a verification prompt.';
const APPLE_AUTHENTICATION_FAILED = 'Apple Account authentication failed. Confirm the saved credentials and try again.';
const APPLE_AUTHENTICATION_INTERRUPTED = 'The server restarted during Apple Account verification. Start again.';
const APPLE_AUTHENTICATION_FAILURE_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Apple rejected the saved credentials. Check the Apple Account email and password.',
  device_verification_required: 'Apple requires verification from a trusted device. Check the iPad for an Apple prompt.',
  rate_limited: 'Apple temporarily rate-limited sign-in. Wait before trying again.',
  apple_store_unavailable: 'Apple’s sign-in service is temporarily unavailable. Try again later.',
  account_disabled: 'Apple disabled sign-in for this account. Check its status with Apple.',
  apple_request_timed_out: 'Apple’s sign-in request timed out. Check connectivity and try again.',
  apple_network_unavailable: 'dkrypt could not reach Apple’s sign-in service. Check server connectivity.',
  apple_request_failed: 'Apple’s sign-in request failed. Try again later.',
  action_signature_rejected: 'Apple rejected the signed sign-in request. The downloader needs an update.',
  action_signing_failed: 'dkrypt could not prepare Apple’s signed sign-in request.',
  apple_response_invalid: 'Apple returned an unexpected sign-in response. The downloader may need an update.',
  apple_client_setup_failed: 'The Apple downloader could not initialize its client.',
  storefront_lookup_failed: 'The Apple downloader could not load Apple’s sign-in configuration.',
  provider_session_storage_failed: 'The Apple downloader could not securely save its sign-in session.',
  apple_sign_in_rejected: 'Apple rejected the sign-in request. Check account status and try again.',
  verification_code_rejected: APPLE_VERIFICATION_CODE_REJECTED,
};

function isTwoFactorRequired(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'two_factor_required';
}

function isAuthenticationTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.message === AUTHENTICATION_TIMEOUT_MESSAGE);
}

function authenticationFailureMessage(error: unknown): string {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? APPLE_AUTHENTICATION_FAILURE_MESSAGES[code] ?? APPLE_AUTHENTICATION_FAILED : APPLE_AUTHENTICATION_FAILED;
}

export function createAppleAccountAuthenticationOperation(dependencies: AppleAccountAuthenticationDependencies) {
  const now = dependencies.now ?? Date.now;
  let current = dependencies.repository.read() ?? { state: 'idle' as const };
  if (current.state === 'running') {
    current = { ...current, state: 'interrupted', completedAt: now(), error: APPLE_AUTHENTICATION_INTERRUPTED };
    dependencies.repository.write(current);
  }

  function persist(status: AppleAccountAuthenticationStatus): void {
    current = status;
    dependencies.repository.write(status);
    dependencies.onStatusChanged?.();
  }

  function start(verificationCode?: string): AppleAccountAuthenticationStatus {
    if (verificationCode !== undefined && !/^\d{6}$/.test(verificationCode)) throw new Error('enter the six-digit Apple verification code');
    if (current.state === 'running') return { ...current };
    if (current.state === 'verification_required' && verificationCode === undefined) return { ...current };

    const started: AppleAccountAuthenticationStatus = { state: 'running', operationId: randomUUID(), startedAt: now() };
    persist(started);
    const controller = new AbortController();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const provider = Promise.resolve().then(() => dependencies.authenticate(verificationCode, controller.signal));
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const error = new Error(AUTHENTICATION_TIMEOUT_MESSAGE);
        controller.abort(error);
        reject(error);
      }, dependencies.timeoutMs);
      timeout.unref?.();
    });

    void Promise.race([provider, timeoutPromise]).then(() => {
      persist({ ...started, state: 'succeeded', completedAt: now() });
    }).catch((error: unknown) => {
      if (isTwoFactorRequired(error)) {
        persist({
          ...started,
          state: 'verification_required',
          completedAt: now(),
          error: verificationCode === undefined ? APPLE_TWO_FACTOR_REQUIRED : APPLE_VERIFICATION_CODE_REJECTED,
        });
        return;
      }
      const message = isAuthenticationTimeout(error, controller.signal) || timedOut
        ? AUTHENTICATION_TIMEOUT_MESSAGE
        : authenticationFailureMessage(error);
      persist({ ...started, state: 'failed', completedAt: now(), error: message });
    }).finally(() => {
      if (timeout) clearTimeout(timeout);
    }).catch(() => {
      log.error('could not persist Apple Account authentication result', { operationId: started.operationId });
    });

    return { ...current };
  }

  return {
    status(): AppleAccountAuthenticationStatus {
      return { ...current };
    },
    start,
    reset(): void {
      if (current.state === 'running') throw new Error('Apple Account verification is currently running');
      persist({ state: 'idle' });
    },
  };
}
