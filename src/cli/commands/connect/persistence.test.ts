import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * That `connect` writes down what it just authorised.
 *
 * Read off the source, which is the same technique `selection.test.ts` uses on
 * `main.ts` and for the same reason: this is wiring, no unit test reaches it,
 * and the thing that went wrong is a call that was never made rather than a
 * value that was wrong.
 *
 * **What happened.** `declareConnection` edited a `ConfigDocument` held in
 * memory and nothing ever saved it. A connect stored the credential, wrote the
 * grant into the profile, printed `connections.yaml += gmail.x` among its
 * changes, and left the file untouched — so the account was authorised,
 * absent from every listing, and unusable. Every test passed, because each one
 * asserted on the returned `changes` or on a document object rather than on
 * what reached the disk.
 *
 * A real end-to-end test would be better and is not available: every provider
 * that ships needs a browser or a pasted secret to get as far as declaring
 * anything.
 */

const SOURCE = readFileSync(join(import.meta.dir, 'index.ts'), 'utf8');

describe('connect persists what it declares', () => {
  test('saves the connections document', () => {
    expect(SOURCE).toContain('connectionsDocument.save()');
  });

  test('saves it unconditionally, not only when a profile was named', () => {
    // `connect --workspace local` authorises into the workspace and grants
    // nothing. That is the path where the row is the *only* thing written, so
    // gating this save the way the profile's is gated would restore the bug for
    // exactly the command that most needs it.
    const at = SOURCE.indexOf('connectionsDocument.save()');
    const line = SOURCE.slice(SOURCE.lastIndexOf('\n', at) + 1, at).trim();

    expect(line).toBe('await');
  });

  test('saves the connections file before the profile', () => {
    // A grant naming a connection the workspace does not hold is refused at
    // load by `assertGrantsResolve`. If only one of the two writes lands it has
    // to be the connection, or the workspace will not open.
    expect(SOURCE.indexOf('connectionsDocument.save()')).toBeLessThan(
      SOURCE.indexOf('document.save()', SOURCE.indexOf('connectionsDocument.save()') + 1),
    );
  });
});
