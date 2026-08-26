import type { IdentityEntry, ProfileSelection, Resolution } from '#profile';
import { ConfigDocument } from '../config-edit.ts';
import { ensureIdentityConnection, repairLines, repaired } from '../config-repair.ts';
import { announce, announceProfile, emit, ok, print, style, table, warn } from '../output.ts';
import { resolveProfile, resolveProfileOnly, type GlobalFlags } from '../runtime.ts';
import { nextAfterEdit, publishProfileEdit } from '../publish.ts';

/**
 * `lanes link identity` — who this profile's owner is, for anything written as them.
 *
 * A control-plane command under ADR-007, and the reason is sharper here than for
 * most of them: an agent able to edit this could edit the one fact that stops it
 * signing as the wrong person. So the surface it feeds is read-only and the
 * editing is here.
 *
 * Not to be confused with `src/cli/identity.ts`, which is about a *connection's*
 * identity — which account it is, as the provider reports it at connect time.
 * This is the owner's, as they declare it.
 *
 * Each command is a data function plus a printing wrapper, for the reason given
 * in `commands/profile.ts`: `--json` needs the facts without the rendering.
 */

/** What `add` did, including anything it provisioned to make it readable. */
export interface IdentityAdded {
  readonly profile: string;
  readonly entry: IdentityEntry;
  /** Config edits made so the surface is reachable at all. Usually empty. */
  readonly provisioned: readonly string[];
  readonly total: number;
}

export interface IdentityListing {
  readonly profile: string;
  readonly entries: readonly IdentityEntry[];
  /** Whether an agent can read them, or only the file can. */
  readonly reachable: boolean;
}

/** Whether a rule list puts `identity.*` in force, in either spelling. */
function covers(rules: ReadonlyArray<{ capability: string }>): boolean {
  return rules.some((rule) => rule.capability === '*' || rule.capability === 'identity.*');
}

/**
 * Whether anything but the file can read this profile's identity.
 *
 * Reported rather than assumed, because a profile hand-edited to hold an
 * `identity` block and nothing else is a real state and a likely one — and
 * listing the entries without saying they are unreachable would be the most
 * misleading thing this command could print.
 */
function readable(config: {
  connections: ReadonlyArray<{ provider: string }>;
  policy: { allow: ReadonlyArray<{ capability: string }>; deny: ReadonlyArray<{ capability: string }> };
}): boolean {
  return (
    config.connections.some((connection) => connection.provider === 'identity') &&
    covers(config.policy.allow) &&
    !covers(config.policy.deny)
  );
}

/**
 * Declare one entry, and make sure something can read it.
 *
 * The provisioning is the part worth understanding. An `identity` block on its
 * own is inert: `allowedConnections` finds no connection row for the provider
 * and returns nothing *before* it consults policy, so the surface is absent from
 * `tools/list` with nothing saying why — the same silent failure
 * `ensureIdentityConnection` closes for `setup`. Writing the entry without it
 * would leave an operator looking at a file that says exactly what they meant
 * and an agent that cannot see a word of it.
 *
 * All three edits land in one `save()`, and that is not tidiness:
 * `validateConfig` refuses a `policy.allow` rule naming a provider with no
 * connection, so a run that wrote the rule and failed before the row would
 * leave a profile that no longer loads. One save has no such middle.
 */
export async function addIdentity(
  kind: string,
  value: string,
  options: { note?: string | undefined } & GlobalFlags,
): Promise<{ resolution: Resolution; added: IdentityAdded; published: string }> {
  const { resolution, config, target } = await resolveProfile(options);

  if (config.identity.some((entry) => entry.kind === kind && entry.value === value)) {
    throw new Error(
      `Profile "${resolution.profile}" already declares ${kind} "${value}".\n` +
        `  To change its note: lanes link identity remove ${kind} ${value}, then add it again.`,
    );
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);

  const entry: IdentityEntry = { kind, value, ...(options.note ? { note: options.note } : {}) };
  document.addTo(['identity'], entry, { inline: true });

  const repair = ensureIdentityConnection(document);
  await document.save();

  return {
    resolution,
    added: {
      profile: resolution.profile,
      entry,
      provisioned: repaired(repair) ? repairLines(repair) : [],
      total: config.identity.length + 1,
    },
    published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
  };
}

/**
 * Read the block, without opening a target.
 *
 * `resolveProfileOnly`, deliberately: this reads one field of a YAML file that
 * is declared once and applies to every target the profile has, so demanding
 * `--target` would be the ceremony ADR-037 warns is how a required flag stops
 * being a guard. `SELECTION` files it as `profile`, and this is the call that
 * makes that true rather than merely stated.
 */
export async function readIdentity(
  flags: GlobalFlags,
): Promise<{ selection: ProfileSelection; listing: IdentityListing }> {
  const { selection, config } = await resolveProfileOnly(flags);

  return {
    selection,
    listing: {
      profile: selection.profile,
      entries: config.identity,
      reachable: readable(config),
    },
  };
}

/**
 * Drop one entry, leaving the connection row and the grant behind.
 *
 * Deliberately: removing the last entry would otherwise silently revoke the
 * surface, and the next `identity add` would have to widen policy again. A
 * command that quietly narrows what an agent may read, and a later one that
 * quietly re-widens it, is worse than a surface that reports nothing declared.
 */
export async function removeIdentity(
  kind: string,
  value: string,
  flags: GlobalFlags,
): Promise<{
  resolution: Resolution;
  removed: IdentityEntry;
  remaining: number;
  published: string;
}> {
  const { resolution, config, target } = await resolveProfile(flags);

  const index = config.identity.findIndex((entry) => entry.kind === kind && entry.value === value);
  if (index === -1) {
    throw new Error(
      `Profile "${resolution.profile}" does not declare ${kind} "${value}".\n` +
        `  Run: lanes link identity list`,
    );
  }

  const document = await ConfigDocument.open(resolution.workspaceRoot, resolution.profile);
  document.removeFrom(['identity'], index);
  await document.save();

  return {
    resolution,
    removed: config.identity[index] as IdentityEntry,
    remaining: config.identity.length - 1,
    published: nextAfterEdit(await publishProfileEdit({ resolution, config, target })),
  };
}

export async function identityAdd(
  kind: string,
  value: string,
  options: { note?: string | undefined; json?: boolean } & GlobalFlags,
): Promise<void> {
  const { resolution, added, published } = await addIdentity(kind, value, options);

  return emit(options.json, added, () => {
    announce(resolution);
    print(ok(`${added.entry.kind} ${style.bold(added.entry.value)}`));
    if (added.entry.note) print(`      note    ${added.entry.note}`);

    // Named rather than folded into the success line: this widened what an
    // agent may read, and a command that broadens a grant says which grant.
    for (const line of added.provisioned) print(`      ${style.dim(line)}`);
    if (added.provisioned.length > 0) {
      print(style.dim('      an agent can now read this profile’s identity'));
    }

    print(style.dim(`  ${published}`));
  });
}

export async function identityList(options: { json?: boolean } & GlobalFlags): Promise<void> {
  const { selection, listing } = await readIdentity(options);

  return emit(options.json, listing, () => {
    announceProfile(selection);

    if (listing.entries.length === 0) {
      print(style.dim('This profile declares no identity.'));
      print(
        style.dim('Declare one with: lanes link identity add name "Your Name" --note "when to use it"'),
      );
      return;
    }

    // Grouped by kind for the same reason the provider groups them: the mistake
    // this exists to prevent is a name used where an address was wanted.
    const kinds = [...new Set(listing.entries.map((entry) => entry.kind))];
    const ordered = kinds.flatMap((kind) =>
      listing.entries.filter((entry) => entry.kind === kind),
    );

    table(
      ordered.map((entry) => [
        `  ${style.dim(entry.kind)}`,
        style.bold(entry.value),
        entry.note ? style.dim(entry.note) : '',
      ]),
    );

    if (!listing.reachable) {
      print('');
      print(warn('declared, but no agent can read it'));
      print(
        style.dim(
          '      the identity surface needs a connection row and an identity.* allow rule;',
        ),
      );
      print(style.dim('      adding an entry with this command writes both.'));
    }
  });
}

export async function identityRemove(
  kind: string,
  value: string,
  options: { json?: boolean } & GlobalFlags,
): Promise<void> {
  const { resolution, removed, remaining, published } = await removeIdentity(kind, value, options);

  return emit(options.json, { removed, remaining }, () => {
    announce(resolution);
    print(ok(`removed ${removed.kind} ${style.bold(removed.value)}`));
    if (remaining === 0) {
      print(style.dim('      the surface stays granted, and now reports nothing declared'));
    }
    print(style.dim(`  ${published}`));
  });
}
