import { expect, test } from 'bun:test';
import { withRequestTimeout } from './apiRequestTimeout';

test('aborts a request that never settles and returns the configured timeout message', async () => {
  const timeoutMessage = 'Apple Account save timed out';
  let aborted = false;
  const result = await Promise.race([
    withRequestTimeout((signal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(signal.reason);
      }, { once: true });
    }), 10, timeoutMessage).then(() => 'resolved', (error: unknown) => error instanceof Error ? error.message : String(error)),
    new Promise<string>((resolve) => setTimeout(() => resolve('request still pending'), 40)),
  ]);

  expect(result).toBe(timeoutMessage);
  expect(aborted).toBe(true);
});

test('does not abort a request that completes before the deadline', async () => {
  let signal: AbortSignal | undefined;
  const result = await withRequestTimeout(async (requestSignal) => {
    signal = requestSignal;
    return 'saved';
  }, 10, 'timed out');

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(result).toBe('saved');
  expect(signal?.aborted).toBe(false);
});
