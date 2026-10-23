import { expect, test } from 'bun:test';
import { ApiError } from './apiErrors';
import { retryAfterReauthentication } from './reauthenticatedRequest';

test('reauthenticates and retries once when a sensitive action requires recent authentication', async () => {
  let attempts = 0;
  let reauthenticationCount = 0;
  const result = await retryAfterReauthentication(
    async () => {
      attempts++;
      if (attempts === 1) throw new ApiError('reauthentication required', 401, 'reauthentication_required');
      return 'saved';
    },
    async () => { reauthenticationCount++; },
  );

  expect(result).toBe('saved');
  expect(attempts).toBe(2);
  expect(reauthenticationCount).toBe(1);
});

test('does not retry unrelated failures', async () => {
  let attempts = 0;
  let reauthenticationCount = 0;
  await expect(retryAfterReauthentication(
    async () => {
      attempts++;
      throw new ApiError('not allowed', 403, 'forbidden');
    },
    async () => { reauthenticationCount++; },
  )).rejects.toMatchObject({ code: 'forbidden' });

  expect(attempts).toBe(1);
  expect(reauthenticationCount).toBe(0);
});
