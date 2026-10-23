import { ApiError } from './apiErrors.js';

export async function parseApiResponse(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    const message = response.status === 504
      ? 'The service gateway timed out before the request completed (HTTP 504). Check service status before retrying.'
      : `The server returned an unreadable response (HTTP ${response.status}).`;
    throw new ApiError(message, response.status);
  }
}
