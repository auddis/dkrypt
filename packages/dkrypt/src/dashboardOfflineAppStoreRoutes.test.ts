import { expect, test } from 'bun:test';
import Fastify from 'fastify';
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { PermissionFlag } from '#permissions.js';
import { setSessionCookie } from '#session.js';
import type { Response } from '#http.js';
import { createDashboardOfflineAppStoreRoutes } from '#routes/dashboardOfflineAppStoreRoutes.js';
import type { OfflineAppStoreReadiness } from '#offlineAppStore.js';

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
