import { expect, test } from 'bun:test';
import { resolveWithin } from '#util/resolveWithin.js';

test('returns a completed request and clears its deadline', async () => {
  await expect(resolveWithin(Promise.resolve('ready'), 100)).resolves.toEqual({ completed: true, value: 'ready' });
});

test('returns promptly when a request remains pending and tolerates its later rejection', async () => {
  let rejectRequest: ((error: Error) => void) | undefined;
  const request = new Promise<string>((_resolve, reject) => { rejectRequest = reject; });
  await expect(resolveWithin(request, 10)).resolves.toEqual({ completed: false });
  rejectRequest?.(new Error('late failure'));
});

test('preserves a request failure before the deadline', async () => {
  await expect(resolveWithin(Promise.reject(new Error('probe failed')), 100)).rejects.toThrow('probe failed');
});
