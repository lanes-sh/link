import { RESERVED_PROVIDER_IDS } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import {
  connectionRefOf,
  defaultConnectionLabel,
  listProfiles,
  loadProfileConfig,
  readConnections,
  resolveTargetWorkspace,
  resolveWorkspaceRoot,
} from '#profile';
import { RESERVED_SURFACES } from '../config-repair.ts';
import { emit, heading, print, style, table } from '../output.ts';
import type { GlobalFlags } from '../runtime.ts';

/**
 * `lanes link connection list` — every account this workspace holds, and which
 * profiles reach each.
 *
 * The listing that had nowhere to live under contract 2, because there was no
 * such thing as "the workspace's connections": each profile had its own list
 * and `status` printed one profile's. A connection belongs to the workspace now
 * (ADR-057), so the question "what have I authorised" has one answer.
 *
 * **The profiles column is the useful half.** An account granted to nobody is
 * connected and unreachable, which looks identical to a working one from
 * anywhere else — and an account granted to more profiles than the operator
 * remembers is how a disconnect surprises somebody. Both are visible here and
 * nowhere else.
 *
 * Workspace-scoped, so it takes no `--profile`. Passing one would narrow the
 * column rather than the rows, which is a different command.
 */

export interface ConnectionSummary {
  readonly key: string;
  readonly provider: string;
  readonly account: string;
  readonly label: string | null;
  /** Whether this is part of the owner layer rather than somebody's account. */
  readonly builtIn: boolean;
  /** Every profile in the workspace whose grants name it. */
  readonly grantedTo: readonly string[];
}

export async function connectionList(flags: GlobalFlags & { json?: boolean }): Promise<void> {
  const local = resolveWorkspaceRoot();
  const root = await resolveTargetWorkspace(local, flags.target ?? 'local');

  const held = (await readConnections(root)).connections;

  // Read once, ahead of the loop. The alternative is a file read per connection
  // per profile, which on a workspace with fifteen accounts and three profiles
  // is forty-five reads of five files.
  const grants = new Map<string, string[]>();
  for (const name of await listProfiles(root)) {
    try {
      const { config } = await loadProfileConfig(root, name);
      for (const grant of config.grants) {
        grants.set(grant.connection, [...(grants.get(grant.connection) ?? []), name]);
      }
    } catch {
      // A profile that will not load is `check`'s to report. Dropping it here
      // makes this listing answer for the ones that do rather than failing
      // wholesale on one broken file.
    }
  }

  const summaries: ConnectionSummary[] = held.map((connection) => {
    const key = connectionRefOf(connection);
    return {
      key,
      provider: connection.provider,
      account: connection.account,
      label: connection.label ?? null,
      builtIn: RESERVED_PROVIDER_IDS.includes(connection.provider),
      grantedTo: grants.get(key) ?? [],
    };
  });

  return emit(flags.json, { workspace: flags.target ?? 'local', connections: summaries }, () => {
    print(style.dim(`workspace ${style.bold(flags.target ?? 'local')}  ${root}`));

    const accounts = summaries.filter((one) => !one.builtIn);
    const builtIns = summaries.filter((one) => one.builtIn);

    if (accounts.length === 0) {
      print('');
      print(style.dim('No accounts connected yet. Connect one with: lanes link connect <provider>'));
    } else {
      heading(`Accounts (${accounts.length})`);
      table(accounts.map(row));
    }

    if (builtIns.length > 0) {
      heading(`Your own material (${builtIns.length})`);
      table(builtIns.map(row));
    }

    print('');
    print(
      style.dim(
        'A connection reaches a profile only where that profile grants it:\n' +
          '  lanes link grant <provider>.<id> --profile <name>',
      ),
    );
  });
}

/**
 * What each provider is called, by id.
 *
 * The catalogue's manifests plus the owner layer, which is registered separately
 * and is deliberately absent from `PROVIDERS`. A workspace-local manifest is not
 * here: this command reads files rather than building a registry, and one custom
 * provider falling back to its account is a smaller price than a registry build
 * on a listing.
 */
const PROVIDER_NAMES = new Map<string, string>([
  ...PROVIDER_MANIFESTS.map((manifest): [string, string] => [manifest.id, manifest.name]),
  ...Object.entries(RESERVED_SURFACES),
]);

function row(one: ConnectionSummary): string[] {
  // "granted to nobody" is said rather than left blank, because a blank column
  // reads as "not loaded yet" and this is a fact about the config.
  const reach =
    one.grantedTo.length === 0
      ? style.dim('no profile grants it')
      : one.grantedTo.join(', ');

  // The account was this column's fallback, which meant an unlabelled row read
  // as its address and said nothing about which service the address is at. The
  // derived name says both, and is the one the dashboard and the connect prompt
  // show for the same row.
  const named = PROVIDER_NAMES.get(one.provider);
  const label = one.label ?? (named ? defaultConnectionLabel(named, one.account) : one.account);

  return [`  ${style.bold(one.key)}`, label, reach];
}
