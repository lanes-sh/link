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
   * Remove a key, leaving everything around it untouched.
   *
   * The counterpart to `setIn`, and it exists because a block a command wrote
   * has to be a block that command can take back. `lanes link knowledge use
   * local` moves memory and skills off a repository, and a `knowledge:` block
   * left behind afterwards would point the profile at the repository it just
   * stopped using — a config that is not merely untidy but wrong.
   *
   * Absent is not an error: removing what is not there is what the caller
   * wanted, and a profile whose targets do not all have the key is the ordinary
   * case rather than a broken one.
   */
  removeIn(path: readonly (string | number)[]): void {
    if (this.#document.getIn(path as (string | number)[]) === undefined) return;
    this.#document.deleteIn(path as (string | number)[]);
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
   * Drop one item out of a sequence, by position.
   *
   * By index rather than by value because the items this is used on are
   * mappings: matching one by value would mean deciding which fields count as
   * its identity, and the caller has already decided that by finding it. The
   * index is therefore the caller's to compute against the *validated* config,
   * whose order this file preserves.
   *
   * `save` re-validates, so removing an item that something else references
   * fails there rather than landing a config that no longer loads.
   */
  removeFrom(path: readonly (string | number)[], index: number): void {
    this.#document.deleteIn([...path, index] as (string | number)[]);
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
#
# "deploy" adds a "deployments:" list here. It is an index, not configuration —
# nothing resolves from it. It records where a deployment lives so that losing
# the target block out of a profile does not lose the service, the bucket, and
# the credential store along with it. "lanes link sync targets" reads it.
contract: 1
`;
}
