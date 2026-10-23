import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardOfflineAppStoreRoutes } from '#routes/dashboardOfflineAppStoreRoutes.js';
import type { OfflineAppStoreReadiness } from '#offlineAppStore.js';
import type { CredentialRetrievalStatus } from '#offlineAppStoreCredential.js';

function sessionCookie(permissions: bigint, reauthenticated = false): string {
  let value = '';
  const response = { setHeader: (_name: string, cookie: string) => { value = cookie; } } as unknown as Response;
  setSessionCookie(response, { sub: 'root', permissions, reauthenticatedAt: reauthenticated ? Date.now() : undefined });
  return value.split(';', 1)[0]!;
}

function readiness(): OfflineAppStoreReadiness {
  return {
    enabled: false,
    ready: false,
    downloaderAvailable: true,
    decryptorAvailable: false,
    terminalAvailable: true,
    fairPlayAuthorized: false,
    vault: { encryptionReady: true, accountConfigured: true, credentialConfigured: false, accountHint: 'a•••@icloud.com' },
    blockers: ['offline decryption is disabled', 'FairPlay decryptor is missing'],
  };
}

test('offline App Store management is manager-only and does not expose account secrets', async () => {
  const calls: string[] = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    saveAccount: (appleId, password) => {
      calls.push(`account:${appleId}:${password}`);
      return readiness().vault;
    },
    saveCredential: (credential) => {
      calls.push(`credential:${credential}`);
      return readiness().vault;
    },
    authenticate: async (code) => { calls.push(`authenticate:${code ?? ''}`); },
    clear: () => { calls.push('clear'); return true; },
  }));

  try {
    const unauthenticated = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status' });
    const member = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { cookie: sessionCookie(PermissionFlag.requestDecrypt) } });
    const apiKeyOnly = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { authorization: 'Bearer dk_live_example' } });
    const administrator = await server.inject({ method: 'GET', url: '/v1/dashboard/appstore-offline/status', headers: { cookie: sessionCookie(PermissionFlag.administrator) } });
    expect(unauthenticated.statusCode).toBe(401);
    expect(member.statusCode).toBe(403);
    expect(apiKeyOnly.statusCode).toBe(401);
    expect(administrator.statusCode).toBe(200);
    expect(administrator.body).not.toMatch(/password|credentialValue|ciphertext|sessionSnapshot/i);

    const reauthenticationRequired = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/appstore-offline/account',
      headers: { cookie: sessionCookie(PermissionFlag.administrator) },
      payload: { appleId: 'admin@example.test', password: 'sensitive-password' },
    });
    expect(reauthenticationRequired.statusCode).toBe(401);
    expect(reauthenticationRequired.json()).toMatchObject({ code: 'reauthentication_required' });

    const saved = await server.inject({
      method: 'PUT',
      url: '/v1/dashboard/appstore-offline/account',
      headers: { cookie: sessionCookie(PermissionFlag.administrator, true) },
      payload: { appleId: 'admin@example.test', password: 'sensitive-password' },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain('sensitive-password');
    expect(calls).toEqual(['account:admin@example.test:sensitive-password']);
  } finally {
    await server.close();
  }
});

test('offline App Store authentication accepts only a six-digit one-time code', async () => {
  const submitted: Array<string | undefined> = [];
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    authenticate: async (code) => { submitted.push(code); },
  }));
  const headers = { cookie: sessionCookie(PermissionFlag.administrator, true) };

  try {
    const invalid = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/authenticate', headers, payload: { verificationCode: '12345' } });
    const valid = await server.inject({ method: 'POST', url: '/v1/dashboard/appstore-offline/authenticate', headers, payload: { verificationCode: '123456' } });
    expect(invalid.statusCode).toBe(400);
    expect(valid.statusCode).toBe(200);
    expect(submitted).toEqual(['123456']);
    expect(valid.body).not.toContain('123456');
  } finally {
    await server.close();
  }
});

test('Apple Account authentication aborts and returns a timeout when the provider never responds', async () => {
  let receivedSignal: AbortSignal | undefined;
  let releaseProvider: () => void = () => {};
  let abortObserved = false;
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    authenticate: ((_code?: string, signal?: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<void>((resolve, reject) => {
        releaseProvider = resolve;
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          reject(signal.reason);
        }, { once: true });
      });
    }),
  }, { authenticationTimeoutMs: 10 }));

  try {
    const result = await Promise.race([
      server.inject({
        method: 'POST',
        url: '/v1/dashboard/appstore-offline/authenticate',
        headers: { cookie: sessionCookie(PermissionFlag.administrator, true) },
        payload: {},
      }).then((response) => response),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 50)),
    ]);

    expect(result?.statusCode).toBe(504);
    expect(result?.json()).toMatchObject({ error: 'Apple Account verification timed out. Try again after checking Apple Account status.' });
    expect(receivedSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
  } finally {
    releaseProvider();
    await server.close();
  }
});

test('FairPlay credential retrieval requires recent manager authentication and targets only the requested device', async () => {
  const targets: string[] = [];
  let retrievalStatus: CredentialRetrievalStatus = { state: 'idle' };
  const server = Fastify().withTypeProvider<TypeBoxTypeProvider>();
  await server.register(createDashboardOfflineAppStoreRoutes({
    readiness,
    getCredentialRetrievalStatus: () => retrievalStatus,
    retrieveCredential: (deviceId) => {
      targets.push(deviceId);
      retrievalStatus = { state: 'running', deviceId };
      return retrievalStatus;
    },
  }));
  const manager = { cookie: sessionCookie(PermissionFlag.administrator) };
  const reauthenticatedManager = { cookie: sessionCookie(PermissionFlag.administrator, true) };

  try {
    const unauthorized = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/credential/retrieve',
      headers: manager,
      payload: { deviceId: 'ipad-exact-id' },
    });
    const started = await server.inject({
      method: 'POST',
      url: '/v1/dashboard/appstore-offline/credential/retrieve',
      headers: reauthenticatedManager,
      payload: { deviceId: 'ipad-exact-id' },
    });
    const status = await server.inject({
      method: 'GET',
      url: '/v1/dashboard/appstore-offline/status',
      headers: manager,
    });

    expect(unauthorized.statusCode).toBe(401);
    expect(started.statusCode).toBe(202);
    expect(targets).toEqual(['ipad-exact-id']);
    expect(status.json().credentialRetrieval).toEqual({ state: 'running', deviceId: 'ipad-exact-id' });
    expect(status.body).not.toMatch(/credentialValue|ciphertext|password|fairPlayCredential/i);
  } finally {
    await server.close();
  }
});
