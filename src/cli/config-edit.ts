import { rename, writeFile } from 'node:fs/promises';
import { Document, parseDocument, YAMLSeq, type Node } from 'yaml';
import {
  CONNECTIONS_FILE,
  ConfigError,
  WORKSPACE_FILE,
  LEGACY_WORKSPACE_FILE,
  workspaceSchema,
  assertConnectionsUnique,
  connectionsFileSchema,
  findSecrets,
  formatSecretFindings,
  isRemoteWorkspace,
  readWorkspaceFile,
  validateConfig,
  validateConfigShape,
  workspaceFiles,
  writeWorkspaceFile,
  layout,
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

/**
 * Validate a document against the schema for the file it is.
 *
 * The key is the discriminator because it is the only thing that is always
 * right: a caller could be asked to say which shape it holds, and a caller that
 * said the wrong one would get the wrong check silently.
 */
function validateDocument(
  raw: unknown,
  path: string,
  key: string | undefined,
  options: { shapeOnly?: boolean },
): void {
  // Either name. The contract-3 migration rewrites the registry under the name
  // it still has, and a document checked against the wrong schema fails with
  // "instance: expected object" — which reads as a corrupt profile rather than
  // as a registry being validated as one.
  if (key === WORKSPACE_FILE || key === LEGACY_WORKSPACE_FILE) {
    const parsed = workspaceSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        `${path}:\n${parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
      );
    }
    return;
  }

  if (key === CONNECTIONS_FILE) {
    const secrets = findSecrets(raw);
    if (secrets.length > 0) {
      throw new ConfigError(
        `${path}: ${formatSecretFindings(secrets)}`,
        secrets.map((finding) => finding.path),
      );
    }

    const parsed = connectionsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ConfigError(
        `${path}:\n${parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`).join('\n')}`,
      );
    }

    assertConnectionsUnique(parsed.data.connections);
    return;
  }

  if (options.shapeOnly === true) validateConfigShape(raw, path);
  else validateConfig(raw, path);
}

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
    return ConfigDocument.openKey(workspaceRoot, layout.profileConfig(profile));
  }

  /**
   * Open any document the workspace holds, by key.
   *
   * `open` above is this with the profile path spelled out, and stays because
   * it is what almost every caller wants. This exists for `connections.yaml`,
   * which is a workspace document rather than a profile's (ADR-057) and needs
   * the same comment-preserving edit path — a connection row carries the
   * account label an operator wrote, and rewriting the file through the schema
   * would drop every comment beside it.
   */
  static async openKey(workspaceRoot: string, key: string): Promise<ConfigDocument> {
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
      // A `YAMLSeq` rather than the plain `[node]` this used to set. The array
      // is not a collection the document API will traverse — the same hazard
      // `setIn` above documents — so the *first* append landed and the second
      // found a value with no `.add` and threw `existing.add is not a
      // function`. `#expand` below reads `.items` and was silently a no-op for
      // the same reason, leaving the sequence in flow style.
      //
      // Latent until contract 3: every path this was called with
      // (`connections`, `policy.allow`) already existed, so the branch ran at
      // most once per document. `grants:` is genuinely absent on a profile
      // being repaired, which is what made the second append reachable.
      const created = new YAMLSeq();
      created.add(node);
      this.#document.setIn(path as (string | number)[], created);
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
  /**
   * `shapeOnly` validates the schema and the secret scan, and skips the
   * referential checks.
   *
   * For the contract 1 → 2 migration, and nothing else. That migration rewrites
   * the structure of a file which may *also* carry an unrelated problem the
   * loader refuses — a connection row still spelling a renamed provider is the
   * one that actually happens. Blocking the structural fix on the unrelated one
   * would leave the file stuck at a contract nothing reads, which is a worse
   * place to be than contract 2 with a stale row that `doctor --fix` names and
   * repairs.
   *
   * The half it keeps is the half that matters for a write: the schema, and the
   * scan that stops a credential value being written into config.
   */
  async save(options: { shapeOnly?: boolean } = {}): Promise<void> {
    const rendered = this.toString();

    // Throws on any validation failure, including a credential value that has
    // crept in — so a CLI edit can never introduce one.
    //
    // Which schema, decided by the key rather than by the caller. This class
    // edits two shapes now: a profile, and the workspace's `connections.yaml`
    // (ADR-057). Validating one against the other's schema is not a stricter
    // check, it is the wrong one — a connections file has no `instance:` block,
    // so it would be refused for a field it is not supposed to have.
    validateDocument(this.#document.toJSON(), this.#path, this.#location?.key, options);

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
