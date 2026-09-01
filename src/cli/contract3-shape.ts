import { RESERVED_PROVIDER_IDS } from '#connectivity';
import type { ContractRename, LegacyConnection, LegacyProfile } from './contract3.ts';
import { keyOf } from './contract3.ts';

/**
 * Turning contract 2's shape into contract 3's, without touching a file.
 *
 * Split from the flow because these are the decisions and that is the ordering:
 * which connections exist after hoisting, what each profile's grants become, and
 * what a rule with an expiry means. Every defect review found in this migration
 * was in one of those three, and none of them needed a filesystem to reproduce.
 */

/**
 * Hoist every profile's connections into one list.
 *
 * **Keyed on provider and account, not on the id.** The common case is two
 * profiles that both connected the same mailbox: same provider, same account,
 * usually the same id, and they merge into one row because they *are* one
 * account. The interesting case is two profiles each holding a row spelled
 * `gmail.main` naming different mailboxes, which is legal under contract 2
 * because a connection lived inside one profile and nothing ever compared them.
 *
 * That collision is resolved by renaming, never by picking. Both accounts are
 * real, both have a credential, and choosing either would take somebody's
 * mailbox away silently. The second becomes `gmail.main_2`, and the rename is
 * reported so the operator sees it before anything else reads the file.
 */
export function hoistConnections(profiles: ReadonlyMap<string, LegacyProfile>): {
  rows: LegacyConnection[];
  renames: ContractRename[];
  perProfile: Map<string, Map<string, string>>;
} {
  const rows: LegacyConnection[] = [];
  const renames: ContractRename[] = [];
  const byAccount = new Map<string, LegacyConnection>();
  const taken = new Set<string>();
  const perProfile = new Map<string, Map<string, string>>();

  for (const [profile, config] of profiles) {
    const mapping = new Map<string, string>();
    perProfile.set(profile, mapping);

    for (const connection of config.connections ?? []) {
      // Two profiles' owner layers are never the same thing, whatever their
      // rows say. Every contract-2 profile carried an identical owner layer
      // written from a fixed table — `{memory: 'Memory', vault: 'Vault', ...}`
      // — so an identity of provider-plus-account made all of them collide and
      // merge. That is the one outcome ADR-059 forbids: interleaving two sets of
      // notes is not reversible and not reviewable, and for the vault the wrong
      // answer is a credential. Keying on the profile forces a rename instead.
      const owner = RESERVED_PROVIDER_IDS.includes(connection.provider);
      const identity = owner
        ? `${connection.provider} @${profile}`
        : `${connection.provider} ${connection.account}`;
      const existing = byAccount.get(identity);

      if (existing) {
        // The same account, already hoisted. This profile's old key maps to
        // whatever the first one settled on, which may itself be a rename.
        mapping.set(keyOf(connection), keyOf(existing));
        continue;
      }

      let id = connection.id;
      if (taken.has(`${connection.provider}.${id}`)) {
        // The profile's own name for an owner-layer surface, which is what
        // ADR-059 specifies and reads far better than `memory.main_2` when the
        // thing being separated is "work's notes". A numeric suffix is the
        // fallback for a real account, and for the case where the profile name
        // is itself taken.
        const preferred = owner ? sanitise(profile) : `${id}_2`;
        let candidate = preferred;
        let suffix = 2;
        while (taken.has(`${connection.provider}.${candidate}`)) {
          suffix += 1;
          candidate = `${preferred}_${suffix}`;
        }
        renames.push({
          from: `${connection.provider}.${id}`,
          to: `${connection.provider}.${candidate}`,
          reason: owner
            ? `"${profile}" has its own ${connection.provider}, which is not "${id}"'s`
            : `"${profile}" named a different account (${connection.account}) with that id`,
        });
        id = candidate;
      }

      const row: LegacyConnection = { ...connection, id };
      rows.push(row);
      byAccount.set(identity, row);
      taken.add(keyOf(row));
      mapping.set(keyOf(connection), keyOf(row));
    }
  }

  return { rows, renames, perProfile };
}

/** A profile name as a connection id: the same alphabet `connectionRef` allows. */
function sanitise(profile: string): string {
  const cleaned = profile.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+/, '');
  return cleaned.length > 0 ? cleaned : 'two';
}

/**
 * A rule, in whichever of the two shapes contract 2 accepted, with its expiry.
 *
 * Reading the capability alone got both directions wrong, and it is the same
 * mistake `config-repair.ts` documents. `isRuleActive` is what made a lapsed
 * rule inert, so dropping `expires_at` turned an allow that died months ago into
 * a live permanent grant — and an expired *deny* into a permanent one, which is
 * not the safe direction either, because a deny outranks every allow.
 *
 * A rule that has already lapsed is dropped rather than carried: it granted and
 * denied nothing on the day of the migration, and writing it forward would give
 * it a meaning it did not have.
 */
type Rule = string | { capability: string; expires_at: string };

function patternsOf(rules: unknown, now = Date.now()): Rule[] {
  if (!Array.isArray(rules)) return [];

  return rules.flatMap((rule): Rule[] => {
    if (typeof rule === 'string') return [rule];

    const object = rule as { capability?: unknown; expires_at?: unknown } | null;
    const capability = object?.capability;
    if (typeof capability !== 'string') return [];

    const expiry = object?.expires_at;
    if (typeof expiry !== 'string') return [capability];

    const at = Date.parse(expiry);
    if (Number.isNaN(at)) return [capability];
    return at > now ? [{ capability, expires_at: expiry }] : [];
  });
}

/** The capability a rule names, whichever shape it is in. */
function capabilityOf(rule: Rule): string {
  return typeof rule === 'string' ? rule : rule.capability;
}

/**
 * The grant rows one contract-2 profile becomes.
 *
 * Every connection gets the rules that named its provider, which is precisely
 * what the flat block meant: rules covered every account of a provider in the
 * profile. So this loses nothing, and gains the ability to diverge afterwards.
 *
 * A rule naming a provider the profile has no connection for is dropped rather
 * than carried. Under contract 2 an `allow` like that was refused at load, and a
 * `deny` was permitted as a note to self; there is nowhere to put either now,
 * because a row without a connection is not expressible.
 */
export function grantsFor(
  config: LegacyProfile,
  mapping: ReadonlyMap<string, string>,
): { connection: string; allow: Rule[]; deny: Rule[] }[] {
  const allow = patternsOf(config.policy?.allow);
  const deny = patternsOf(config.policy?.deny);

  const covers = (rule: Rule, provider: string): boolean => {
    const pattern = capabilityOf(rule);
    return pattern === '*' || pattern.startsWith(`${provider}.`);
  };

  return (config.connections ?? []).map((connection) => {
    const provider = connection.provider;
    // A bare `*` becomes the provider wildcard rather than being copied
    // through. It would still mean the same thing inside a row, which is
    // already scoped to one connection, but writing it out is what makes the
    // file say so. An expiry rides along untouched.
    const widen = (rule: Rule): Rule => {
      if (typeof rule === 'string') return rule === '*' ? `${provider}.*` : rule;
      return rule.capability === '*' ? { ...rule, capability: `${provider}.*` } : rule;
    };

    return {
      connection: mapping.get(keyOf(connection)) ?? keyOf(connection),
      allow: allow.filter((rule) => covers(rule, provider)).map(widen),
      deny: deny.filter((rule) => covers(rule, provider)).map(widen),
    };
  });
}
