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
}

const AUTHENTICATION_TIMEOUT_MESSAGE = 'Apple Account verification timed out. Check Apple Account status before trying again.';
const APPLE_TWO_FACTOR_REQUIRED = 'Apple requires a six-digit verification code. Check the trusted device.';
const APPLE_VERIFICATION_CODE_REJECTED = 'Apple did not accept that verification code. Request a fresh code and try again.';
const APPLE_AUTHENTICATION_FAILED = 'Apple Account authentication failed. Confirm the saved credentials and try again.';
const APPLE_AUTHENTICATION_INTERRUPTED = 'The server restarted during Apple Account verification. Start again.';

function isTwoFactorRequired(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === 'two_factor_required';
}

function isAuthenticationTimeout(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.message === AUTHENTICATION_TIMEOUT_MESSAGE);
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
        : APPLE_AUTHENTICATION_FAILED;
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
