import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
 * against the connect guide, which is the list, and the README is asserted to
 * point at it.
 *
 * The guide is now `connect.mdx` on lanes.sh, in the website repository.
 * `LANES_DOCS_DIR` points at `src/content/docs/link` in that checkout; unset,
 * the completeness check skips rather than passing by not looking.
 */
/**
 * The catalogue page, which is `providers.mdx` and not `connect.mdx`.
 *
 * It moved: `connect.mdx` became the guide to *how* connecting works and now
 * links to the catalogue rather than being it. This pointed at the old file for
 * long enough that the two checks below reported 105 missing providers on a
 * website where every one of them is documented, which is the failure mode a
 * cross-repository test has and a same-repository one does not.
 */
const CONNECT = process.env.LANES_DOCS_DIR
  ? join(process.env.LANES_DOCS_DIR, 'providers.mdx')
  : undefined;

/** The catalogue's path, for the checks `skipIf` already gates on it existing. */
function connectGuide(): string {
  if (CONNECT === undefined) throw new Error('LANES_DOCS_DIR is not set');
  return CONNECT;
}

/** Every `lanes link connect <target>` the README tells someone to run. */
function connectTargetsIn(text: string): string[] {
  const found = new Set<string>();

  for (const match of text.matchAll(/lanes link connect ([a-z_]+)/g)) found.add(match[1]!);

  return [...found].sort();
}

describe('the README', () => {
  test('points at the list rather than being it', async () => {
    const readme = await readFile(README, 'utf8');

    expect(readme).toContain('lanes.sh/docs/link/connect');
    expect(readme).toContain('src/providers/README.md');
  });

  test.skipIf(CONNECT === undefined)('the catalogue gives a command for every provider', async () => {
    const named = new Set(connectTargetsIn(await readFile(connectGuide(), 'utf8')));

    const missing = PROVIDER_MANIFESTS.map((manifest) => manifest.id).filter(
      (id) => !named.has(id),
    );

    expect(missing).toEqual([]);
  });

  test.skipIf(CONNECT === undefined)('the catalogue marks exactly the untested providers', async () => {
    // A status maintained in two places is a status that is wrong in one of
    // them. `untested.ts` is the source; this is the check that the prose agrees
    // with it, in both directions — an unmarked untested provider overclaims,
    // and a marked tested one undersells something that works.
    const guide = await readFile(connectGuide(), 'utf8');

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

    // The README is always here; the guide only when LANES_DOCS_DIR names the
    // website checkout, so this half narrows rather than skipping outright.
    const unknown = [
      ...connectTargetsIn(await readFile(README, 'utf8')),
      ...(CONNECT ? connectTargetsIn(await readFile(CONNECT, 'utf8')) : []),
    ].filter((target) => !resolvable.has(target));

    expect(unknown).toEqual([]);
  });
});
