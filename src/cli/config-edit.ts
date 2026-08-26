import { rename, writeFile } from 'node:fs/promises';
import { Document, parseDocument, type Node } from 'yaml';
import {
  ConfigError,
  isRemoteWorkspace,
  readWorkspaceFile,
  validateConfig,
  workspaceFiles,
  writeWorkspaceFile,
} from '#profile';

/**
 * Editing a profile's config file.
 *
 * The file is the source of truth, and an operator's comments and key ordering
 * are part of what they wrote — a CLI that reformats the file on every edit
 * makes the file hostile to hand-editing, which then makes the CLI mandatory.
 * So edits go through the YAML Document API, which preserves both.
 *
 * Every write validates the resulting document first and writes through a
 * temporary file, so a rejected edit leaves the original exactly as it was.
 * A config file left invalid by a failed command is worse than a command that
 * refuses to run.
 */

export class ConfigDocument {
  readonly #document: Document;
  readonly #path: string;
  readonly #location: { workspaceRoot: string; key: string } | undefined;

  private constructor(
    document: Document,
    path: string,
    location?: { workspaceRoot: string; key: string },
  ) {
    this.#document = document;
    this.#path = path;
    this.#location = location;
  }

  /**
   * Open a profile's config for editing, wherever the workspace keeps it.
   *
   * Takes the workspace root and a profile rather than a path, because those
   * are no longer the same thing: a workspace may be a bucket, and `join` on a
   * `gs://` URL produces something that addresses nothing.
   */
  static async open(workspaceRoot: string, profile: string): Promise<ConfigDocument> {
    const key = `profiles/${profile}.yaml`;
    const shown = isRemoteWorkspace(workspaceRoot)
      ? `${workspaceRoot}/${key}`
      : `${workspaceRoot}/${key}`;

    const text = await readWorkspaceFile(workspaceFiles(workspaceRoot), key);
    if (text === null) throw new ConfigError(`${shown}: no such config file`);

    const document = parseDocument(text);
    if (document.errors.length > 0) {
      throw new ConfigError(`${shown}: ${document.errors[0]?.message ?? 'could not parse YAML'}`);
    }
    return new ConfigDocument(document, shown, { workspaceRoot, key });
  }

  static fromText(text: string, path = '<config>'): ConfigDocument {
    return new ConfigDocument(parseDocument(text), path);
  }

  get path(): string {
    return this.#path;
  }

  toString(): string {
    return this.#document.toString({ lineWidth: 0 });
  }

  toJSON(): unknown {
    return this.#document.toJSON();
  }

  /** Read a value by path, e.g. `['providers', 'gmail', 'enabled']`. */
  getIn(path: readonly (string | number)[]): unknown {
    return this.#document.getIn(path);
  }

  setIn(path: readonly (string | number)[], value: unknown): void {
    // `createNode` first: a plain JS object stored here is not a YAML
    // collection, so a later `setIn` into the same path cannot traverse it and
    // fails with "Expected YAML collection". Setting `providers.gmail` and then
    // `providers.gmail.oauth_app` is exactly that sequence.
    const node =
      value !== null && typeof value === 'object' ? this.#document.createNode(value) : value;

    this.#document.setIn(path as (string | number)[], node);
    this.#expand(path.slice(0, -1));
  }

  /**
   * Append to a sequence, creating it if absent.
   *
   * `inline` renders the appended item on one line. Policy rules are far
   * easier to scan one-per-line — which is how init.md's own example writes
   * them — while a connection carries enough fields to want a block.
   */
  addTo(path: readonly (string | number)[], value: unknown, options: { inline?: boolean } = {}): void {
    const node = this.#document.createNode(value) as Node & { flow?: boolean };
    if (options.inline) node.flow = true;

    // `null` as well as `undefined`: a key written with no value under it —
    // `connections:` on a line of its own, which is what deleting the last entry
    // by hand leaves behind — parses to a null scalar rather than to nothing.
    // Calling `.add` on that is a TypeError with a stack trace, where the same
    // file reached through `open` reports a readable config error, so the
    // difference decided whether a command explained itself or crashed.
    const existing = this.#document.getIn(path as (string | number)[]);
    if (existing === undefined || existing === null) {
      this.#document.setIn(path as (string | number)[], [node]);
    } else {
      (existing as { add(item: unknown): void }).add(node);
    }

    this.#expand(path);
  }

  /**
   * Force a collection we just grew onto multiple lines.
   *
   * A template starts with `connections: []`, and the YAML library keeps that
   * flow style as items are appended — so a file meant to be hand-edited
   * silently degrades into one unreadable line. Only the container we touched
   * is expanded; a leaf like `{ adapter: filesystem, path: ./data/x }` reads
   * better on one line and is left alone.
   */
  #expand(path: readonly (string | number)[]): void {
    const node = path.length === 0 ? this.#document.contents : this.#document.getIn(path as (string | number)[]);
    const collection = node as { flow?: boolean; items?: unknown[] } | null;

    if (collection && Array.isArray(collection.items) && collection.items.length > 0) {
      collection.flow = false;
    }
  }

  /**
   * Validate the resulting document, then write it atomically.
   *
   * Validation happens on the rendered text rather than the in-memory tree so
   * that what is checked is exactly what would land on disk.
   */
  async save(): Promise<void> {
    const rendered = this.toString();

    // Throws on any validation failure, including a credential value that has
    // crept in — so a CLI edit can never introduce one.
    validateConfig(this.#document.toJSON(), this.#path);

    if (!this.#location) {
      throw new ConfigError(`${this.#path}: opened from text, so there is nowhere to save it`);
    }

    const { workspaceRoot, key } = this.#location;

    if (isRemoteWorkspace(workspaceRoot)) {
      // One PUT, which object storage makes atomic by construction — there is
      // no torn write to guard against and no temporary object to leave behind
      // if the process dies between the two halves of a rename.
      await writeWorkspaceFile(workspaceFiles(workspaceRoot), key, rendered);
      return;
    }

    // Write-then-rename locally, so a rejected edit or a crash mid-write leaves
    // the original exactly as it was. 0600 because the file names credential
    // refs and the policy that governs them.
    const path = `${workspaceRoot}/${key}`;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, rendered, { mode: 0o600 });
    await rename(temporary, path);
  }
}

/** The reserved provider id the setup surface registers under. */
const SETUP_PROVIDER_ID = 'setup';

/**
 * What a repair did, split by what a caller does with each half.
 *
 * `connect` reports config edits under `changes` and policy under `granted`,
 * and both are serialised verbatim by `--json` — so an audit asking what a
 * command widened reads only the second, and one blended list of sentences
 * filed the grant as an edit and left prose in a field meant for matching.
 */
export interface SetupRepair {
  /** Config edits made, spelled for display. Empty when none were needed. */
  readonly changes: readonly string[];
  /** Allow rules added — patterns, not prose, so a caller can act on them. */
  readonly granted: readonly string[];
}

/**
 * Give a profile the `setup` surface if it does not already have it.
 *
 * A profile written before the surface existed has neither the connection row
 * nor the allow rule, and the failure is silent in the worst way:
 * `allowedConnections` returns nothing for a provider with no connection row
 * *before* it consults policy, so `setup_overview` and `setup_provider` are
 * simply absent from `tools/list` with nothing saying why. An agent asked what
 * is connected then has nothing to read and invents a command — which is the
 * bug this exists to close, not a hypothetical.
 *
 * Both halves or neither: a connection row without `setup.*` is as inert as the
 * rule without the row, so adding one alone would look like a fix and change
 * nothing.
 *
 * CLI-side by construction. ADR-007 keeps configuration mutation off the served
 * surface, and a deployed revision holds `objectViewer` on `profiles/`
 * (ADR-023) so it could not write this even if the code let it.
 */
export function ensureSetupConnection(document: ConfigDocument): SetupRepair {
  // Raw YAML, so nothing here has been through a schema: this runs over sibling
  // profiles that were never validated, and every field is whatever was typed.
  const config = document.toJSON() as {
    connections?: unknown;
    policy?: { allow?: unknown; deny?: unknown };
  } | null;

  const rule = `${SETUP_PROVIDER_ID}.*`;
  const covers = (pattern: string): boolean => pattern === '*' || pattern === rule;

  // Denied on purpose, and a deny beats an allow — so writing the rule would
  // widen nothing while announcing that an agent "can now see what is connected
  // here", which would be false. Deleting the two lines no longer removes the
  // surface, because the next `connect` or `deploy` puts them back; a deny is
  // the way it stays off, so it is the one thing this must not undo.
  //
  // Only a rule covering the whole surface counts. `deny: [setup.provider]` is
  // an operator narrowing it, not switching it off, and that narrowing survives
  // the repair untouched — which is the point of denying one capability.
  if (patternsIn(config?.policy?.deny).some(covers)) return { changes: [], granted: [] };

  const changes: string[] = [];
  const granted: string[] = [];

  const connections = Array.isArray(config?.connections) ? config.connections : [];
  const isSetup = (row: unknown): boolean =>
    (row as { provider?: unknown } | null)?.provider === SETUP_PROVIDER_ID;

  if (!connections.some(isSetup)) {
    // Inline, and `main` for the id, so a repaired profile is spelled exactly
    // like `newProfileTemplate` writes a fresh one. Two spellings of one row is
    // how a template and its repair drift apart.
    document.addTo(
      ['connections'],
      { id: 'main', provider: SETUP_PROVIDER_ID, account: 'Setup' },
      { inline: true },
    );
    changes.push(`connections += ${SETUP_PROVIDER_ID}.main`);
  }

  // `*` already covers it. Re-stating the rule under a blanket allow would be
  // noise in the file and a diff the operator did not ask for.
  if (!patternsIn(config?.policy?.allow).some(covers)) {
    document.addTo(['policy', 'allow'], rule, { inline: true });
    granted.push(rule);
  }

  return { changes, granted };
}

/** Whether a repair did anything, without a caller adding up two lists. */
export function repaired(repair: SetupRepair): boolean {
  return repair.changes.length > 0 || repair.granted.length > 0;
}

/** The repair as display lines, in the order the two halves are applied. */
export function repairLines(repair: SetupRepair): string[] {
  return [...repair.changes, ...repair.granted.map((rule) => `policy.allow += ${rule}`)];
}

/**
 * The patterns a raw policy list puts *in force*, in either spelling.
 *
 * `policyRuleSchema` takes a bare pattern or `{ capability, expires_at }` and
 * both parse to the same thing, so reading only the string form would re-add a
 * rule the operator had already written with an expiry. Anything that is
 * neither is dropped rather than guessed at: this reads unvalidated YAML, and a
 * malformed rule is for `validateConfig` to report, not for this to interpret.
 *
 * **Expiry is part of the reading.** `evaluate` holds a rule to
 * `expiresAt === undefined || expiresAt > now` (`#policy`), so a lapsed rule
 * grants and denies nothing — and reading the capability alone got both
 * directions wrong. A lapsed *allow* read as live, so the repair wrote the row,
 * skipped the rule, and announced success: the inert half-state this exists to
 * prevent. A lapsed *deny* blocked the repair for good and printed nothing,
 * because having nothing to add is how "already had it" looks.
 *
 * An unparseable date reads as lapsed, which is the safe direction — it adds a
 * working rule rather than trusting a broken one, and the `save` that follows
 * hands the malformed value to `validateConfig`, whose job it is to complain.
 */
function patternsIn(rules: unknown, now = Date.now()): string[] {
  if (!Array.isArray(rules)) return [];

  return rules
    .filter((rule) => {
      const expiry = (rule as { expires_at?: unknown } | null)?.expires_at;
      return typeof expiry !== 'string' || Date.parse(expiry) > now;
    })
    .map((rule) =>
      typeof rule === 'string' ? rule : (rule as { capability?: unknown } | null)?.capability,
    )
    .filter((pattern): pattern is string => typeof pattern === 'string');
}

/**
 * A fresh profile config.
 *
 * Written with comments, because this is the file an operator will read first
 * and most of what it needs to say is *why*, not *what*.
 */
export function newProfileTemplate(profile: string, port: number, targets: string): string {
  return `# Lanes Link profile: ${profile}
#
# This file is the source of truth for what exists. It never contains a
# credential value — only "_ref" pointers into the credential store, which
# lives beside it and is encrypted at rest.
#
# Edit it by hand or through the CLI; both are supported, and CLI edits
# preserve your comments and ordering.
contract: 1

instance:
  profile: ${profile}
  port: ${port}
  host: 127.0.0.1

# Adapter selection is per target, and every command names the one it means:
#
#     lanes link status --profile ${profile} --target <name>
#
# There is no default. A target is chosen on the command line or not at all,
# so a flag that goes missing fails here rather than quietly running somewhere
# else (ADR-037). Everything below "targets" is target-independent and declared
# exactly once.
targets:
${targets}
# The bearer token for the endpoint this profile serves.
#
# "lanes link start" serves every profile in the workspace from one URL, and this
# token is what opens it — so it admits every profile that "lanes link outputs"
# lists, not only this one. Each call names the profile it means. Run a separate
# workspace if you need a token that cannot reach them all.
auth:
  mode: bearer
  token_ref: profile/token

limits:
  requests_per_minute: 120      # per profile
  upstream_calls_per_minute: 60 # per connection, protects vendor quota

# App registrations, shared by every connection of that vendor.
oauth_apps: {}

# One entry per authorised account. "account" is the identity the provider
# reports — an address, a workspace — so this list says whose data is reachable
# without having to look anything up.
#
# "setup" holds no account. It lets an agent see what is connected here and what
# connecting something else would take, so it can tell you the command to run
# rather than guess at one. It is read-only: nothing it offers writes config,
# stores a credential, signs in, or changes what is permitted — those stay in
# this CLI (ADR-007, ADR-019). Delete this entry and the allow line below to
# remove it entirely.
connections:
  - { id: main, provider: setup, account: Setup }

# Only what is listed here is reachable, and an empty policy grants nothing.
#
# Rules name capabilities, never accounts: "gmail.*" covers every Gmail
# connection in this profile. To grant two accounts differently, run a second
# profile — profiles share no database and no credential store. They do now
# share an endpoint and its token, so that separation is enforced per call
# rather than per URL.
#
#   allow: ['*']                  everything, which is what connect writes
#   allow: [notion.*, gmail.*]    two providers
#   deny:  [gmail.send_message]   a deny always beats an allow
policy:
  allow: [setup.*]
  deny: []
`;
}

export function newWorkspaceTemplate(): string {
  return `# Lanes Link workspace
#
# A workspace holds one or more profiles, and one endpoint serves all of them:
# every call names the profile it means, with --profile. Profiles never share a
# database or a credential store, so what one holds is invisible to another.
contract: 1
`;
}
