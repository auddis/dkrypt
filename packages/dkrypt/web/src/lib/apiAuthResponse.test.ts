import { expect, test } from 'bun:test';
import { isUnauthenticatedResponse } from './apiAuthResponse';

test('preserves an authenticated session when an action requires recent authentication', async () => {
  const response = Response.json({ error: 'reauthentication is required for this action', code: 'reauthentication_required' }, { status: 401 });

  expect(await isUnauthenticatedResponse(response)).toBe(false);
  expect(await response.json()).toMatchObject({ code: 'reauthentication_required' });
});

test('preserves an authenticated session when additional MFA is required', async () => {
  const response = Response.json({ error: 'multi-factor authentication is required', code: 'mfa_required' }, { status: 401 });

  expect(await isUnauthenticatedResponse(response)).toBe(false);
});

test('invalidates expired or unrecognized unauthorized sessions', async () => {
  expect(await isUnauthenticatedResponse(Response.json({ error: 'unauthorized', code: 'unauthorized' }, { status: 401 }))).toBe(true);
  expect(await isUnauthenticatedResponse(Response.json({ error: 'unknown', code: 'unknown' }, { status: 401 }))).toBe(true);
  expect(await isUnauthenticatedResponse(Response.json({ error: 'forbidden', code: 'forbidden' }, { status: 403 }))).toBe(false);
});
