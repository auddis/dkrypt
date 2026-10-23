import { expect, test } from 'bun:test';
import { ApiError } from './apiErrors';
import { parseApiResponse } from './apiResponse';

test('a gateway timeout response is reported with its HTTP status instead of a JSON parse error', async () => {
  const response = new Response('<html>gateway timeout</html>', {
    status: 504,
    headers: { 'content-type': 'text/html' },
  });

  let error: unknown;
  try {
    await parseApiResponse(response);
  } catch (cause) {
    error = cause;
  }

  expect(error).toBeInstanceOf(ApiError);
  expect(error).toMatchObject({
    message: 'The service gateway timed out before the request completed (HTTP 504). Check service status before retrying.',
    statusCode: 504,
  });
  expect((error as Error).message).not.toContain('<html>');
});

test('valid JSON API responses continue to parse normally', async () => {
  await expect(parseApiResponse(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
});
