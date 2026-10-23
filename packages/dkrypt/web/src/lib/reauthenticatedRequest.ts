import { ApiError } from './apiErrors.js';

export async function retryAfterReauthentication<T>(
  operation: () => Promise<T>,
  reauthenticate: () => Promise<void>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== 'reauthentication_required') throw error;
    await reauthenticate();
    return operation();
  }
}
