import { describe, expect, test } from 'bun:test';
import type { ProviderManifest } from '#connectivity';
import { calendar, contacts, docs, drive, gmail, googleTasks, sheets } from '../index.ts';
import { manifestOf } from '#providers/index.ts';

/**
 * The vendored spec and the requested scopes have to agree.
 *
 * `vendor.ts` states the rule in prose — "everything here is reachable under the
 * scopes the manifest requests" — and nothing enforced it. The failure it guards against is quiet: an operation added to the
 * selection without the scope it needs produces a tool that lists fine, is
 * allowed by policy, and returns 403 the first time an agent calls it.
 *
 * Google publishes the answer per operation in the spec's own `security` block,
 * so the check costs nothing but was never wired up.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

interface Operation {
  readonly operationId?: string;
  /** Alternatives, not requirements: holding any one scope in any one entry suffices. */
  readonly security?: Record<string, string[]>[];
}

function httpSpecPath(manifest: ProviderManifest): string {
  if (manifest.connector.kind !== 'http') throw new Error(`${manifest.id} is not an http connector`);
  return manifest.connector.openapi;
}

async function operationsOf(manifest: ProviderManifest): Promise<Operation[]> {
  const spec = (await Bun.file(httpSpecPath(manifest)).json()) as {
    paths: Record<string, Record<string, Operation>>;
  };

  return Object.values(spec.paths).flatMap((item) =>
    Object.entries(item)
      // Path-level keys — `parameters` and friends — sit beside the methods.
      .filter(([method]) => METHODS.includes(method))
      .map(([, operation]) => operation),
  );
}

/** Every scope that would satisfy this operation, flattened across alternatives. */
function acceptedScopes(operation: Operation): string[] {
  return [...new Set((operation.security ?? []).flatMap((entry) => Object.values(entry).flat()))];
}

/**
 * The scopes the verification doc justifies.
 *
 * Google will not accept a submission until every sensitive and restricted
 * scope carries a justification, a data-usage statement and a demo video, and
 * none of those live in this repository — they are free text on a console form.
 * `docs/detailed/google-verification.md` is where the text is written and kept;
 * the console is where it is pasted. That leaves the same gap `vendor.ts` had
 * before the check above existed: prose stating a rule, and nothing enforcing
 * it.
 *
 * Only the block between the markers is read. The prose around it names scopes
 * deliberately *not* requested — `https://mail.google.com/` and unrestricted
 * `drive`, both of which the doc tells a reviewer are refused — and matching on
 * those would invert the test.
 */
const VERIFICATION_DOC = new URL(
  '../../../../docs/detailed/google-verification.md',
  import.meta.url,
).pathname;

async function justifiedScopes(): Promise<Set<string>> {
  const source = await Bun.file(VERIFICATION_DOC).text();
  const block = /<!-- scopes:begin -->([\s\S]*?)<!-- scopes:end -->/.exec(source)?.[1];
  if (block === undefined) throw new Error(`${VERIFICATION_DOC}: no scopes block`);

  return new Set(block.match(/https:\/\/www\.googleapis\.com\/auth\/[\w.]+/g) ?? []);
}

describe.each([
  ['gmail', gmail],
  ['drive', drive],
  ['sheets', sheets],
  ['docs', docs],
  ['calendar', calendar],
  ['google_tasks', googleTasks],
  ['contacts', contacts],
])('%s', (_name, entry) => {
  // `gmail` is a definition rather than a bare manifest now: it authors
  // `send_message`, because assembling a MIME message is not something an
  // OpenAPI document can describe. Everything this file checks is still about
  // the declaration, so the manifest is what it reads — plus the authored names,
  // which the redaction check below has to know about.
  const manifest = manifestOf(entry);
  const authored = new Set(
    ('capabilities' in entry ? entry.capabilities : []).map((capability) => capability.name),
  );
  test('every vendored operation is reachable under the scopes we request', async () => {
    if (manifest.auth.kind !== 'oauth') throw new Error('expected an oauth manifest');
    const granted = new Set(manifest.auth.scopes);
    const operations = await operationsOf(manifest);

    expect(operations.length).toBeGreaterThan(0);

    const unreachable = operations
      .filter((operation) => {
        const accepted = acceptedScopes(operation);
        // An operation Google documents no scope for is not our problem to
        // solve here; only a stated requirement we fail to meet is.
        return accepted.length > 0 && !accepted.some((scope) => granted.has(scope));
      })
      .map((operation) => operation.operationId);

    expect(unreachable).toEqual([]);
  });

  /**
   * Setup has to name every scope the manifest will ask for.
   *
   * These scopes are not granted by consenting in a browser — they have to be
   * added by hand under Google Auth Platform → DATA ACCESS first, and a scope
   * requested but never registered there is refused at the consent screen with
   * an error naming no scope in particular. The setup block is the only place
   * anyone is told which ones to add, so a scope missing from it is a dead end
   * with no breadcrumb.
   *
   * Easy to get wrong precisely because it looks like duplication: the list is
   * passed to `googleSetup` separately from the one in `auth.scopes`, and
   * nothing but this makes the two agree.
   */
  test('setup names every scope the manifest requests', () => {
    if (manifest.auth.kind !== 'oauth') throw new Error('expected an oauth manifest');
    const steps = (manifest.setup?.steps ?? []).join('\n');

    expect(manifest.auth.scopes.filter((scope) => !steps.includes(scope))).toEqual([]);
  });

  /**
   * A scope reaches the consent screen justified, or it does not reach it.
   *
   * The failure is slow and lands on someone else. Adding a scope to a manifest
   * works immediately for anyone running their own OAuth client, so nothing
   * locally says it is incomplete — but on the hosted client it goes out
   * unjustified, and Google answers weeks later by rejecting the whole
   * submission rather than the one scope. The check costs a file read.
   */
  test('every scope the manifest requests is justified for verification', async () => {
    if (manifest.auth.kind !== 'oauth') throw new Error('expected an oauth manifest');
    const justified = await justifiedScopes();

    expect(manifest.auth.scopes.filter((scope) => !justified.has(scope))).toEqual([]);
  });

  test('nothing vendored composes a message beside the authored capability', async () => {
    // `send_message` is authored (`gmail/send.ts`) because assembling a MIME
    // message is not something an OpenAPI document can describe. It is named for
    // what it does rather than after Google's operationId, which matches the
    // other provider that sends mail — but it means a *generated* send would not
    // collide with it. Add `gmail.users.messages.send` to SELECTION and you get
    // `gmail_users_messages_send` beside `gmail_send_message`: two send tools
    // differing only in whether they compose the message for you, with nothing to
    // warn you. The composite's authored-wins rule cannot help, because that
    // matches on name and these differ.
    //
    // This named `messages.send` alone, and that was too narrow by exactly one
    // operation. `send_message` owns *creating* a message here, both halves of
    // it — `draft_only: true` posts the assembled message to /drafts — so a
    // draft is not a separate feature, and `drafts.create` shipped beside it for
    // a whole release doing the same job with a `raw` the caller had to
    // assemble. An operator hit it: a slow draft call was re-issued, and the
    // model had two tools to choose from on the way. The rule is about
    // composing, so the list is every operation that composes.
    //
    // `drafts.update` joined the list once `send_message` grew `draft_id`. It
    // was excluded on the grounds that it reached a draft `send_message` could
    // not, and that ceased to be true — leaving two ways to rewrite a draft,
    // one of which cannot carry the attachment the rewrite is usually for.
    //
    // `drafts.delete` stays off it, and not by oversight: discarding a draft
    // composes nothing, so there is no second implementation to collide with.
    if (!authored.has('send_message')) return;

    const vendored = new Set(
      (await operationsOf(manifest)).map((operation) => operation.operationId),
    );

    const composes = [
      'users.messages.send',
      'users.messages.insert',
      'users.messages.import',
      'users.drafts.create',
      'users.drafts.update',
    ];

    expect(composes.filter((name) => vendored.has(`${manifest.id}.${name}`))).toEqual([]);
  });

  test('nothing vendored creates a Google-native file from its own API', async () => {
    // `spreadsheets.create` and `documents.create` are refused on size, and the
    // number that matters is not the one a reader would reach for. Their bodies
    // are a whole `Spreadsheet`/`Document`, and `mcp-from-openapi` inlines
    // `$ref`s — so the 122 schemas the SELECTION comment used to cite generate a
    // 1,133 KB input schema against a 64 KB budget. The gap between those two
    // figures is wide enough that the refusal was very nearly reversed on the
    // strength of the smaller one.
    //
    // `cli/tools.test.ts` would catch the reintroduction as a budget failure,
    // but it would report it as "this tool is too big" rather than "this
    // decision was already made and measured". Pinned here so a refresh that
    // widens SELECTION fails against the argument.
    const vendored = new Set(
      (await operationsOf(manifest)).map((operation) => operation.operationId),
    );

    const creates = ['sheets.spreadsheets.create', 'docs.documents.create'];
    expect(creates.filter((name) => vendored.has(name))).toEqual([]);
  });

  test('hints name capabilities that exist', async () => {
    // The same failure mode as the redaction check below, with the opposite
    // symptom: a mistyped `redact` key withholds what it meant to keep, and a
    // mistyped `hints` key says nothing at all. Silence is the harder one to
    // notice, because the tool still works — it is just as undiscoverable as it
    // was before someone wrote the hint.
    const declared = Object.keys(manifest.hints ?? {});
    if (declared.length === 0) return;

    const capabilities = new Set(
      (await operationsOf(manifest))
        .map((operation) => operation.operationId)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => (id.startsWith(`${manifest.id}.`) ? id.slice(manifest.id.length + 1) : id)),
    );

    expect(declared.filter((name) => !capabilities.has(name) && !authored.has(name))).toEqual([]);
  });

  test('redaction names capabilities that exist', async () => {
    const declared = Object.keys(manifest.redact ?? {});
    if (declared.length === 0) return;

    // Mirrors `shortenName`: Google's operationIds are already namespaced, so
    // the provider prefix is stripped to form the capability name. A typo here
    // fails silently in production — the lookup misses and the argument values
    // are withheld, which looks exactly like working redaction.
    const capabilities = new Set(
      (await operationsOf(manifest))
        .map((operation) => operation.operationId)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => (id.startsWith(`${manifest.id}.`) ? id.slice(manifest.id.length + 1) : id)),
    );

    // An authored capability is a real capability with a real name; it just is
    // not in the vendored document, because no document describes it.
    expect(
      declared.filter((name) => !capabilities.has(name) && !authored.has(name)),
    ).toEqual([]);
  });
});

/**
 * And nothing justified that is not asked for.
 *
 * This is the direction with teeth. A scope dropped from a manifest leaves the
 * consent screen at once and its justification behind — still in the doc, and
 * therefore still in the console, where it reads as a standing request for
 * access the application no longer makes. Asking for more than is used is one
 * of the things a verification review is looking for, so the stale entry is
 * worse than no entry: it is an argument for something untrue, signed.
 *
 * It also catches the likelier clerical version: the doc's list is typed by
 * hand, and a scope a word off from the one in the manifest justifies something
 * that does not exist while leaving the real one unjustified.
 */
describe('verification', () => {
  test('every scope justified for verification is one a manifest requests', async () => {
    const requested = new Set(
      [gmail, drive, sheets, docs, calendar, googleTasks, contacts].flatMap((entry) => {
        const manifest = manifestOf(entry);
        return manifest.auth.kind === 'oauth' ? manifest.auth.scopes : [];
      }),
    );

    const justified = [...(await justifiedScopes())];
    expect(justified.filter((scope) => !requested.has(scope))).toEqual([]);
  });
});
