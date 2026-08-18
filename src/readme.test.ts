import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { credentialApp } from '#cli/commands/connect/accounts.ts';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';

/**
 * The README names every provider, and names nothing that is not one.
 *
 * This exists because the omission it prevents already happened. `sheets` and
 * `docs` shipped complete — manifests, vendored specs, redaction, tests — and
 * the README went on describing connections as "Gmail, Notion, Linear, Drive,
 * iCloud". Someone with Drive connected asked why the Sheets API was not
 * exposed, and the honest answer was that nothing anywhere told them
 * `lanes link connect sheets` existed. Ten working capabilities, unreachable
 * for want of one line of documentation.
 *
 * A hand-maintained list is what failed, so a hand-maintained list is not the
 * fix on its own. The check is on the command rather than the provider's name
 * because the command is what the reader needs: "Google Sheets" appearing in a
 * sentence is not the same as knowing what to type.
 *
 * `PROVIDER_MANIFESTS`, not `PROVIDERS`, and the difference is not cosmetic.
 * `PROVIDERS` holds the union — a manifest, or a definition wrapping one — and
 * `gmail` became the second kind when it started authoring `send_message`. Read
 * as a manifest, a definition has neither `id` nor `auth`: `credentialApp`
 * threw on the missing `auth`, and the test above quietly stopped covering
 * Gmail at all, because `undefined` fell out of `map` and `toEqual` ignores it.
 * The one provider whose shape changed was the one provider no longer checked,
 * which is this file's own failure mode turned on itself.
 */

const README = new URL('../README.md', import.meta.url).pathname;

/** Every `lanes link connect <target>` the README tells someone to run. */
function connectTargetsIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/lanes link connect ([a-z_]+)/g)) found.add(match[1]!);

  return [...found].sort();
}

describe('the README', () => {
  test('gives a connect command for every provider', async () => {
    const readme = await readFile(README, 'utf8');
    const named = new Set(connectTargetsIn(readme));

    const missing = PROVIDER_MANIFESTS.map((manifest) => manifest.id).filter(
      (id) => !named.has(id),
    );

    expect(missing).toEqual([]);
  });

  test('names no connect target that does not resolve', async () => {
    // Two kinds of target are real. A provider id is the ordinary one. The
    // other is a credential app shared by several providers — `connect icloud`
    // fans out to mail, calendar, and contacts because one app-specific
    // password covers all three. Derived from the manifests rather than listed
    // here, so this test cannot disagree with `connect` about what resolves.
    const resolvable = new Set([
      ...PROVIDER_MANIFESTS.map((manifest) => manifest.id),
      ...PROVIDER_MANIFESTS.map(credentialApp).filter((app): app is string => app !== undefined),
    ]);

    const unknown = connectTargetsIn(await readFile(README, 'utf8')).filter(
      (target) => !resolvable.has(target),
    );

    expect(unknown).toEqual([]);
  });
});
