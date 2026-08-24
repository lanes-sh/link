import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installRoot } from '#profile';

/**
 * What this CLI calls itself when asked.
 *
 * Read from `package.json` at call time rather than substituted in at build
 * time, because there is no build step: the file that declares the version and
 * the file that ships are the same file. `installRoot` walks up to whichever
 * root this is — a checkout during development, or the package directory under
 * `node_modules` once installed — which is the same way `mcp/assets.ts` finds
 * `instructions/`.
 *
 * Answering at all is new with publishing to npm. While the only way to get
 * this CLI was to clone it, `git log` was the answer and a better one; two
 * machines can now be a release apart with nothing on either to say so.
 */
export function version(): string {
  const path = join(installRoot(import.meta.dir), 'package.json');
  const declared = (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version;

  if (!declared) throw new Error(`No "version" in ${path}`);
  return declared;
}
