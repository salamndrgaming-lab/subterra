export const log = {
  info: (msg: string, meta?: Record<string, unknown>) =>
    console.log(`[etl] ${msg}`, meta ?? ''),
  warn: (msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[etl] ${msg}`, meta ?? ''),
  error: (msg: string, err?: unknown) =>
    console.error(`[etl] ${msg}`, err ?? ''),
};

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    log.info(`${label} ✓`, { ms: Date.now() - start });
    return result;
  } catch (err) {
    log.error(`${label} ✗`, err);
    throw err;
  }
}
