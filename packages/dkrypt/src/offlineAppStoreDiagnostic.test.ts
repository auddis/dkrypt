import { expect, test } from 'bun:test';
import { sanitizeAppStoreDownloadDiagnostic } from '#offlineAppStoreDiagnostic.js';

test('App Store download diagnostics preserve provider errors and redact account secrets', () => {
  const credential = Buffer.alloc(16, 9);
  const output = JSON.stringify({
    error: 'license is not available for this account',
    appleId: 'owner@example.test',
    password: 'apple-password',
    keychainPassphrase: 'keychain-passphrase',
    credential: credential.toString('base64url'),
    session: '/dev/shm/dkrypt-appstore-session-secret/config.json',
    helper: '/opt/fairplay-decrypt/download.py',
    sshKey: '/run/secrets/id_ed25519',
    device: '00008030-001624583AF9402E',
    opaque: credential.toString('base64url'),
    opaqueHex: credential.toString('hex'),
  });

  const diagnostic = sanitizeAppStoreDownloadDiagnostic(output, {
    appleId: 'owner@example.test',
    password: 'apple-password',
    keychainPassphrase: 'keychain-passphrase',
    fairPlayCredential: credential.toString('base64'),
  });

  expect(diagnostic).toContain('license is not available for this account');
  expect(diagnostic).not.toContain('owner@example.test');
  expect(diagnostic).not.toContain('apple-password');
  expect(diagnostic).not.toContain('keychain-passphrase');
  expect(diagnostic).not.toContain(credential.toString('base64'));
  expect(diagnostic).not.toContain(credential.toString('base64url'));
  expect(diagnostic).not.toContain(credential.toString('hex'));
  expect(diagnostic).not.toContain('/dev/shm/dkrypt-appstore-session-secret');
  expect(diagnostic).not.toContain('/opt/fairplay-decrypt/download.py');
  expect(diagnostic).not.toContain('/run/secrets/id_ed25519');
  expect(diagnostic).not.toContain('00008030-001624583AF9402E');
});
