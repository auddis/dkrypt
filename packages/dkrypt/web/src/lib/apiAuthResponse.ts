export async function isUnauthenticatedResponse(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = await response.clone().json() as { code?: unknown };
    return body.code !== 'reauthentication_required' && body.code !== 'mfa_required';
  } catch {
    return true;
  }
}
