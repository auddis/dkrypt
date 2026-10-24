import { expect, test } from 'bun:test';
import { sanitizeAppStoreDownloadDiagnostic } from '#offlineAppStoreDiagnostic.js';

test('App Store download diagnostics preserve provider errors and redact account secrets', () => {
  const output = JSON.stringify({
    error: 'license is not available for this account',
    appleId: 'owner@example.test',
    password: 'apple-password',
    keychainPassphrase: 'keychain-passphrase',
    credential: Buffer.alloc(16, 9).toString('base64'),
    session: '/dev/shm/dkrypt-appstore-session-secret/config.json',
  });

  const diagnostic = sanitizeAppStoreDownloadDiagnostic(output, {
    appleId: 'owner@example.test',
    password: 'apple-password',
    keychainPassphrase: 'keychain-passphrase',
    fairPlayCredential: Buffer.alloc(16, 9).toString('base64'),
  });

  expect(diagnostic).toContain('license is not available for this account');
  expect(diagnostic).not.toContain('owner@example.test');
  expect(diagnostic).not.toContain('apple-password');
  expect(diagnostic).not.toContain('keychain-passphrase');
  expect(diagnostic).not.toContain(Buffer.alloc(16, 9).toString('base64'));
  expect(diagnostic).not.toContain('/dev/shm/dkrypt-appstore-session-secret');
});
