import type { Logger } from '#connectivity';

export type { Logger };

/**
 * Where an endpoint's operational events go.
 *
 * Distinct from the audit log, which records what a caller *did* and is a
 * durable, hash-chained artefact. This is the other half: what happened to
 * requests that never reached dispatch, of which a rejected credential is the
 * one that matters. Audit cannot cover it — a refusal record needs a principal,
 * and failing authentication is precisely not having one.
 *
 * Every caller used to pass an object whose four methods were empty, so the
 * warning at the authentication edge was written and discarded on a public URL.
 */

/** Discards everything. For tests, whose output should stay readable. */
export function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

/**
 * Timestamped lines to whichever stream is handed in.
 *
 * The CLI passes stderr, because stdout is what `--raw` and `--json` callers
 * parse. The container passes stdout, which is where Cloud Run collects logs.
 */
export function streamLogger(write: (line: string) => void, now = () => new Date()): Logger {
  const at = (level: string, message: string, detail?: Record<string, unknown>): void => {
    const suffix = detail && Object.keys(detail).length > 0 ? ` ${JSON.stringify(detail)}` : '';
    write(`${now().toISOString()} ${level} ${message}${suffix}`);
  };

  return {
    debug: (message, detail) => at('debug', message, detail),
    info: (message, detail) => at('info', message, detail),
    warn: (message, detail) => at('warn', message, detail),
    error: (message, detail) => at('error', message, detail),
  };
}
