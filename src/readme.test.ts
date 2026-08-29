import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { credentialApp } from '#cli/commands/connect/accounts.ts';
import { RESERVED_BY_GRAMMAR } from '#cli/commands/connect/custom/spec.ts';
import { PROVIDER_MANIFESTS, UNTESTED_PROVIDERS } from '#providers/index.ts';

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

/**
 * The canonical list moved, and the check moved with it.
 *
 * The README carried a row per provider until there were ninety-eight of them,
 * which is not a table anyone reads — it now summarises and links. The rule this
 * file exists for is unchanged and is not about the README: **nothing ships that
 * the documentation never names**, because `sheets` and `docs` once shipped
 * complete and unreachable for want of one line. So completeness is asserted
 * against `docs/connect.md`, which is the list, and the README is asserted to
 * point at it.
 */
const CONNECT = new URL('../docs/connect.md', import.meta.url).pathname;

/** Every `lanes link connect <target>` the README tells someone to run. */
function connectTargetsIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/lanes link connect ([a-z_]+)/g)) found.add(match[1]!);

  return [...found].sort();
}

describe('the README', () => {
  test('points at the list rather than being it', async () => {
    const readme = await readFile(README, 'utf8');

    expect(readme).toContain('docs/connect.md');
    expect(readme).toContain('src/providers/README.md');
  });

  test('the connect guide gives a command for every provider', async () => {
    const named = new Set(connectTargetsIn(await readFile(CONNECT, 'utf8')));

    const missing = PROVIDER_MANIFESTS.map((manifest) => manifest.id).filter(
      (id) => !named.has(id),
    );

    expect(missing).toEqual([]);
  });

  test('the connect guide marks exactly the untested providers', async () => {
    // A status maintained in two places is a status that is wrong in one of
    // them. `untested.ts` is the source; this is the check that the prose agrees
    // with it, in both directions — an unmarked untested provider overclaims,
    // and a marked tested one undersells something that works.
    const guide = await readFile(CONNECT, 'utf8');

    const marked = new Set(
      [...guide.matchAll(/†[^|]*\|\s*`lanes link connect ([a-z_]+)`/g)].map((match) => match[1]!),
    );
    const ids = PROVIDER_MANIFESTS.map((manifest) => manifest.id);

    expect(ids.filter((id) => UNTESTED_PROVIDERS.has(id) && !marked.has(id))).toEqual([]);
    expect(ids.filter((id) => !UNTESTED_PROVIDERS.has(id) && marked.has(id))).toEqual([]);
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
      // The third kind, and the one the guide gained when it started explaining
      // how to declare a service that is not built in. `connect custom` is a
      // second word of the command rather than a provider, and `selection.test.ts`
      // is what keeps that list honest — so it is taken from there rather than
      // spelled again here.
      ...RESERVED_BY_GRAMMAR,
    ]);

    const unknown = [
      ...connectTargetsIn(await readFile(README, 'utf8')),
      ...connectTargetsIn(await readFile(CONNECT, 'utf8')),
    ].filter((target) => !resolvable.has(target));

    expect(unknown).toEqual([]);
  });
});
