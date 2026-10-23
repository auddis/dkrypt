export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await operation(controller.signal);
    if (timedOut) throw new Error(message);
    return result;
  } catch (error) {
    if (timedOut) throw new Error(message);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
