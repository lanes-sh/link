import { relative } from 'node:path';
import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { isRemoteWorkspace, resolveWorkspaceRoot } from '#profile';
import { parseManifest } from '#providers/custom/index.ts';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { announce, emit, ok, progress } from '../../../output.ts';
import { nonInteractivePrompter, terminalPrompter, type Prompter } from '../../../prompt.ts';
import { resolveProfile, type GlobalFlags } from '../../../runtime.ts';
import { PROGRAM } from '../../../usage.ts';
import { runConnect, type ConnectOptions } from '../index.ts';
import { renderOutcome, type ConnectOutcome } from '../outcome.ts';
import { collect, type Blocked } from './ask.ts';
import { deriveDeclaration, deriveManifest } from './derive.ts';
import { RESERVED_BY_GRAMMAR, type CustomFlags } from './spec.ts';
import {
  checkOpenapiReachable,
  manifestDiff,
  manifestPath,
  readExistingManifest,
  renderManifest,
  writeManifest,
} from './write.ts';

/**
 * `lanes link connect custom <id>` — declare a provider, then connect it.
 *
 * The built-in list has never been the boundary: a manifest in the profile's
 * `providers.d/` is validated by the same schema a built-in is and registered
 * into the same registry, which is the scalability claim of the whole manifest
 * design. What was missing was the way in. An operator had to find an
 * undocumented directory, write YAML, and satisfy cross-field rules they could
 * not see — and the one message that would have told them where to put the file
 * named a directory nothing reads.
 *
 * So this composes the two closed unions: a connectivity type and a credential
 * type. Anything not covered by a pair of them is not something to bolt on here
 * — it is a member missing from one of those lists, which is a folder and a
 * schema entry away. `https://lanes.sh/docs/link/connectivity-coverage` is the standing
 * account of which pairs work, which are closed on purpose, and which are not
 * built yet.
 *
 * The manifest is written *before* `runConnect`, because the registry that reads
 * `providers.d/` is built by `openRuntime` on its first line. Everything that
 * can be refused is refused before the write.
 */

export interface ConnectCustomOptions extends GlobalFlags, CustomFlags {
  readonly json?: boolean | undefined;
  /** Forwarded to `connect` untouched. */
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
  readonly label?: string | undefined;
  readonly replace?: boolean | undefined;
  readonly nonInteractive?: boolean | undefined;
  readonly acceptBroadScopes?: boolean | undefined;
  /** Injected by tests, so the declaration can be checked without a runtime. */
  readonly prompter?: Prompter | undefined;
  readonly connectWith?:
    | ((target: string, options: ConnectOptions, announced?: boolean) => Promise<ConnectOutcome>)
    | undefined;
}

export async function connectCustom(
  providerId: string | undefined,
  options: ConnectCustomOptions,
): Promise<void> {
  if (!providerId) throw new Error(`Usage: ${PROGRAM} connect custom <provider-id>`);

  // Both of these are answerable without reading anything, so they come before
  // the profile is resolved: loading a config from a bucket is a network call,
  // and refusing afterwards means having made it to say no.
  refuseUnusableId(providerId);

  // A manifest is read from the workspace and written to the filesystem, and a
  // bucket only does the first. Not a limitation of this command: a deployed
  // revision never rewrites its own config (ADR-007), so a declaration is
  // authored where the operator is and carried up by the publish that follows.
  const root = resolveWorkspaceRoot();
  if (isRemoteWorkspace(root)) {
    throw new Error(
      `This workspace is ${root}, and a manifest is written to a local filesystem.\n` +
        `  Declare it in the workspace you deploy from, and \`${PROGRAM} deploy\` carries it up.`,
    );
  }

  const { resolution, target } = await resolveProfile(options);
  const { workspaceRoot, profile } = resolution;

  // Before it acts, because writing the manifest *is* acting and `usage.ts`
  // promises every command says where. `runConnect` is told it has been said, so
  // the line does not appear twice.
  if (options.json !== true) announce(resolution);

  const path = manifestPath(workspaceRoot, profile, providerId);
  const rerun = `${PROGRAM} connect custom ${providerId} --profile ${profile} --workspace ${target}`;

  const prompter =
    options.prompter ??
    (options.nonInteractive ? nonInteractivePrompter(rerun) : terminalPrompter);

  const collected = await collect(providerId, options, prompter, (missing) =>
    [rerun, ...missing.map((flag) => `--${flag} <value>`)].join(' '),
  );

  if ('missing' in collected) {
    return refuse(blockedOn(collected, providerId), options.json);
  }

  const declaration = deriveDeclaration(collected);
  const text = renderManifest(declaration);

  // Through the loader's own gate, not a copy of it: the entropy check that
  // refuses a pasted credential, then every cross-field rule. A second
  // implementation of "is this a secret" is how the two come to disagree.
  const derived = parseManifest(text, path);

  if (derived.connector.kind === 'http') {
    await checkOpenapiReachable(derived.connector.openapi, workspaceRoot, profile);
  }

  // A connection is labelled with the account it belongs to, and a provider that
  // cannot report one has to be told. Interactively `settleIdentity` asks; with
  // nobody to ask it throws — but only after the credential has been stored, so
  // the operator gets two failed runs instead of one refusal. Checked here
  // because this command is the one that knows no identity block was derived.
  if (options.nonInteractive && !derived.identity && derived.auth.kind !== 'none' && !options.displayName) {
    throw new Error(
      `${derived.name} has no way to report whose account a connection is, so on a run with nobody ` +
        'to ask it has to be named.\n  Nothing was written. Add --display-name "<label>"' +
        (derived.connector.kind === 'http'
          ? ', or --identity-url and --identity-field if the API can answer for itself.'
          : '.'),
    );
  }

  const shown = relative(workspaceRoot, path);
  const existing = await readExistingManifest(path);
  const differences = existing ? manifestDiff(deriveManifest(collected), existing) : [];

  if (existing && differences.length > 0 && !options.replaceManifest) {
    return refuse(alreadyDescribed(shown, differences, rerun, options.replace), options.json);
  }

  const changes: string[] = [];
  if (!existing) {
    await writeManifest(path, text);
    changes.push(`wrote ${shown}`);
  } else if (differences.length > 0) {
    await writeManifest(path, text);
    changes.push(`rewrote ${shown}`);
  } else {
    changes.push(`${shown} unchanged`);
  }

  // Said now rather than only in the outcome: the connect that follows may open
  // a browser, and knowing the file landed is worth having before that.
  progress(ok(changes[0]!));

  // Named field by field rather than spread, because the two commands share a
  // flag name that means different things. `--auth` here is the credential type
  // in the manifest — `none`, `basic`, `api-key` — and on `connect` it names
  // which *route* in, for a provider offering two. Spreading sent `--auth none`
  // straight through, and `connect` refused a provider it had just been handed
  // with "--auth accepts: oauth".
  const handOff = options.connectWith ?? runConnect;
  const outcome = await handOff(
    providerId,
    {
      profile: options.profile,
      target: options.target,
      quiet: options.quiet ?? false,
      ...(options.id ? { id: options.id } : {}),
      ...(options.displayName ? { displayName: options.displayName } : {}),
      ...(options.label ? { label: options.label } : {}),
      ...(options.replace ? { replace: options.replace } : {}),
      ...(options.nonInteractive ? { nonInteractive: options.nonInteractive } : {}),
      ...(options.acceptBroadScopes ? { acceptBroadScopes: options.acceptBroadScopes } : {}),
      ...(options.json ? { json: options.json } : {}),
    },
    true,
  );

  // The manifest first, because it is the change this command made and the rest
  // is what `connect` made. It stays in the list on a failure too: the file is
  // real, it is the operator's now, and the retry is plain `connect` — which is
  // what `then` already says.
  const merged: ConnectOutcome = { ...outcome, changes: [...changes, ...outcome.changes] };

  if (!merged.ok) process.exitCode = 1;

  // `--json` gets the manifest in `changes`, because that list is what a caller
  // counts and matches on. The human rendering does not, because they were told
  // above — before the connect, which is where it mattered — and the same
  // sentence twice reads as two things having happened.
  return emit(options.json, merged, () => renderOutcome(outcome));
}

/**
 * Ids this command cannot create.
 *
 * `custom` is the second word of its own grammar, so such a provider could be
 * declared, registered, and then never connected. The reserved owner ids are
 * refused by `defineProvider` a moment later, but with a rule rather than with
 * the reason — and this is the one place somebody is choosing a name.
 */
function refuseUnusableId(id: string): void {
  if (!/^[a-z][a-z0-9_]*$/.test(id)) {
    throw new Error(
      `"${id}" cannot be a provider id: they are lowercase, start with a letter, and use ` +
        'underscores rather than hyphens — it becomes part of every capability name and every ' +
        `policy rule. Try "${id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}".`,
    );
  }

  if ((RESERVED_BY_GRAMMAR as readonly string[]).includes(id)) {
    throw new Error(
      `"${id}" is the second word of this command, so a provider called "${id}" could be declared ` +
        `and then never connected — \`${PROGRAM} connect ${id}\` would always mean this command. ` +
        'Pick another id.',
    );
  }

  if (RESERVED_PROVIDER_IDS.includes(id)) {
    throw new Error(
      `"${id}" is reserved for what this endpoint provides itself — your memory, skills, vault, ` +
        'setup surface and identity. Pick another id.',
    );
  }

  if (PROVIDER_MANIFESTS.some((manifest) => manifest.id === id)) {
    throw new Error(
      `"${id}" is already built in, so a manifest of yours would shadow it — and a provider ` +
        'silently answering differently from the one it is named after is very hard to diagnose ' +
        `from the outside.\n  Connect the built-in with \`${PROGRAM} connect ${id}\`, or pick ` +
        'another id.',
    );
  }
}

function blockedOn(blocked: Blocked, providerId: string): ConnectOutcome {
  const plural = blocked.missing.length === 1 ? 'value' : 'values';

  return {
    ok: false,
    changes: [],
    granted: [],
    discovered: 0,
    reason: 'needs_declaration',
    message:
      `Declaring ${providerId} needs ${blocked.missing.length} more ${plural}, and this run is ` +
      'non-interactive.\n  Nothing was written. Either run it in a terminal, or pass:',
    needs: [],
    then: blocked.command,
  };
}

function alreadyDescribed(
  shown: string,
  differences: readonly string[],
  rerun: string,
  replacePassed: boolean | undefined,
): ConnectOutcome {
  // `--replace` and `--replace-manifest` are one word apart and do different
  // things, so somebody who reached here with the wrong one is told which.
  const confusion = replacePassed
    ? '\n  (--replace asks for the credential again; the manifest is a separate thing.)'
    : '';

  return {
    ok: false,
    changes: [],
    granted: [],
    discovered: 0,
    reason: 'needs_declaration',
    message:
      `${shown} already describes this provider, differently. Nothing was written.${confusion}\n` +
      `${differences.map((line) => `    ${line}`).join('\n')}\n\n` +
      '  Edit the file and connect it, or replace it:',
    needs: [],
    then: `${rerun} --replace-manifest`,
  };
}

function refuse(outcome: ConnectOutcome, json: boolean | undefined): void | Promise<void> {
  process.exitCode = 1;
  return emit(json, outcome, () => renderOutcome(outcome));
}
