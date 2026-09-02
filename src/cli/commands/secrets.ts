import { ConfigError } from '#profile';
import { assertValidSecretRef } from '#secrets';
import { announceWorkspace, announceProfile, heading, ok, print, style } from '../output.ts';
import {
  openSecretStoreFor,
  primaryProfile,
  resolveProfile,
  resolveProfileOnly,
  type GlobalFlags,
} from '../runtime.ts';

/**
 * `lanes link secrets` — moving credential values between a profile's targets.
 *
 * Credentials follow the target, because each target has its own credential
 * store: `lanes link connect gmail.side --workspace cloud` writes the refresh token into
 * Secret Manager, and the same command with `--workspace local` writes it into
 * the encrypted file. That is the right default and it leaves one gap, which
 * this command fills — a setup built locally first, and now wanted in the
 * cloud, without re-running every OAuth flow.
 *
 * Every operation here is control plane: it writes credential values, so it is
 * CLI-only by design and has no MCP surface (ADR-007). Values are never
 * printed, never passed on argv where they would land in shell history, and
 * never logged — only reference names appear.
 */

export interface SecretsFlags extends GlobalFlags {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  /** Replace a reference that already exists in the destination. */
  readonly overwrite?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export async function secretsPush(flags: SecretsFlags): Promise<void> {
  if (!flags.from || !flags.to) {
    throw new ConfigError('Usage: lanes link secrets push --from <target> --to <target>');
  }
  if (flags.from === flags.to) {
    throw new ConfigError(`--from and --to are both "${flags.from}"; there is nothing to copy.`);
  }

  const { selection, config } = await resolveProfileOnly(flags);
  announceProfile(selection);

  const source = await openSecretStoreFor(selection.workspaceRoot, flags.from);
  const destination = await openSecretStoreFor(selection.workspaceRoot, flags.to);

  const refs = await source.list();
  if (refs.length === 0) {
    print(style.dim(`No credentials in workspace "${flags.from}".`));
    return;
  }

  heading(`${flags.from} → ${flags.to}`);

  // Only asked when it can change the answer: against Secret Manager each of
  // these is an API call, and `--overwrite` ignores the result anyway.
  const existing = new Set<string>();
  if (!flags.overwrite) {
    for (const ref of refs) if (await destination.has(ref)) existing.add(ref);
  }

  const { copy, skip } = pushDecision({ refs, existing, overwrite: flags.overwrite === true });
  const copied: string[] = [];
  const skipped = [...skip];

  for (const ref of copy) {
    if (!flags.dryRun) {
      const value = await source.get(ref);
      // A ref that lists but does not read means the store changed underneath
      // us. Skipping beats writing an empty string over a live credential.
      if (value === null) {
        skipped.push(ref);
        continue;
      }
      await destination.set(ref, value);
    }
    copied.push(ref);
  }

  // Copy, never move. `connect` has a copy-then-delete helper for renaming a
  // connection within one store; across targets both copies are wanted — the
  // local one is what `lanes link start` still runs on.
  for (const ref of copied) print(`  ${style.green('+')} ${ref}`);
  for (const ref of skipped) print(`  ${style.dim('=')} ${style.dim(`${ref}  already present`)}`);

  print('');
  if (flags.dryRun) {
    print(style.dim(`  --dry-run: ${copied.length} would be copied, ${skipped.length} skipped.`));
    return;
  }
  print(ok(`copied ${copied.length}, skipped ${skipped.length}`));
  if (skipped.length > 0 && !flags.overwrite) {
    print(style.dim('  --overwrite replaces what is already there.'));
  }
  print(style.dim(`  The source target keeps its copy; nothing was deleted from "${flags.from}".`));
}

/**
 * Store one value, read from stdin.
 *
 * Never from argv: an argument is in the shell history, in `ps` output while
 * the process runs, and in any transcript of the session. The Postgres
 * connection string is the reason this exists — the cloud target names it with
 * `database.url_ref`, and it has to get into the store somehow.
 */
export async function secretsSet(ref: string | undefined, flags: GlobalFlags): Promise<void> {
  if (!ref) {
    throw new ConfigError(
      'Usage: lanes link secrets set <ref>   (the value is read from stdin)\n' +
        '  e.g. printf %s "$DATABASE_URL" | lanes link secrets set cloud/database_url --workspace cloud',
    );
  }
  assertValidSecretRef(ref);

  // Without this the command waits on a terminal that will never send
  // anything, with no output to explain why — a hang, not an error.
  if (process.stdin.isTTY) {
    throw new ConfigError(
      `lanes link secrets set reads the value from stdin, and stdin is a terminal.\n` +
        `  printf %s "<value>" | lanes link secrets set ${ref}\n` +
        '  Pass it this way rather than as an argument: an argument is in your shell history.',
    );
  }

  // The credential store belongs to the workspace since contract 3, so every
  // profile opened the same one and naming one chose nothing. A profile is
  // still resolved, because `openSecretStoreFor` reads the adapter set through
  // one — so the banner names the workspace rather than reporting whichever
  // profile happened to supply it.
  const { resolution, config, target } = await resolveProfile({
    ...flags,
    profile: await primaryProfile(flags),
  });
  announceWorkspace(resolution);

  const value = (await Bun.stdin.text()).replace(/\n$/, '');
  if (!value) {
    throw new ConfigError(
      `No value on stdin. Pipe one in: printf %s "<value>" | lanes link secrets set ${ref}`,
    );
  }

  const credentials = await openSecretStoreFor(resolution.workspaceRoot, target);
  const replacing = await credentials.has(ref);
  await credentials.set(ref, value);

  print(ok(`${replacing ? 'replaced' : 'stored'} ${style.bold(ref)} in workspace ${target}`));
  if (replacing) {
    print(style.dim('  Anything still using the old value will start failing.'));
  }
}

export async function secretsList(flags: GlobalFlags): Promise<void> {
  // The credential store belongs to the workspace since contract 3, so every
  // profile opened the same one and naming one chose nothing. A profile is
  // still resolved, because `openSecretStoreFor` reads the adapter set through
  // one — so the banner names the workspace rather than reporting whichever
  // profile happened to supply it.
  const { resolution, config, target } = await resolveProfile({
    ...flags,
    profile: await primaryProfile(flags),
  });
  announceWorkspace(resolution);

  const credentials = await openSecretStoreFor(resolution.workspaceRoot, target);
  const refs = await credentials.list();

  heading(`Credential references in workspace ${target} (${refs.length})`);
  if (refs.length === 0) {
    print(style.dim('  none'));
  } else {
    for (const ref of refs) print(`  ${ref}`);
  }

  // The interface has no operation that enumerates values, and this command is
  // not going to become the first one.
  print('');
  print(style.dim('  Names only. There is no command that prints a stored credential value.'));
}

/** Which references a push copies and which it leaves alone. */
export function pushDecision(input: {
  readonly refs: readonly string[];
  readonly existing: ReadonlySet<string>;
  readonly overwrite: boolean;
}): { copy: string[]; skip: string[] } {
  const copy: string[] = [];
  const skip: string[] = [];

  for (const ref of input.refs) {
    if (!input.overwrite && input.existing.has(ref)) skip.push(ref);
    else copy.push(ref);
  }
  return { copy, skip };
}
