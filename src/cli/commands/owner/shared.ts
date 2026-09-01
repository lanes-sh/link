import { ConfigError, type Config } from '#profile';
import { announce, print, style } from '../../output.ts';
import { confirm } from '../../prompt.ts';
import { openRuntime, type GlobalFlags, type Runtime } from '../../runtime.ts';

/**
 * What every `lanes link` command over the owner's own data needs: the flag
 * shape, the runtime wrapper, connection resolution, and the two prompts.
 *
 * All of them are the same shape — open a runtime, announce, act, close — so the
 * wrapper lives here rather than once per noun.
 */

export interface OwnerFlags extends GlobalFlags {
  /** Which connection of this provider, when a profile has more than one. */
  readonly connection?: string | undefined;
  readonly title?: string | undefined;
  readonly tag?: string | undefined;
  readonly description?: string | undefined;
  readonly file?: string | undefined;
  /** `tasks`: which status to set, or to filter a listing by. */
  readonly status?: string | undefined;
  /** `tasks`: when it is due, as the owner would write it. Empty clears it. */
  readonly due?: string | undefined;
  /** `assets`: what to call the stored file, where the path's basename is wrong. */
  readonly name?: string | undefined;
  /** `assets`: for the file whose extension does not say what it is. */
  readonly contentType?: string | undefined;
  /** `entities`: person, company, project — free-form, never a closed list. */
  readonly type?: string | undefined;
  /**
   * `entities`: repeatable, which is why `ownerFlags` needs argv.
   *
   * `parseArgv` keeps only the last value of a repeated flag, and an entity
   * with two email addresses is the case this whole component exists for — so
   * these three read the raw argv through `all()`, as `customFlags` does.
   */
  readonly alias?: readonly string[] | undefined;
  /** `entities`: `email=jan@example.test`, or `github` to mean "has one". */
  readonly attr?: readonly string[] | undefined;
  /** `entities`: `works_at=acme-bv`, or `acme-bv` for any predicate. */
  readonly related?: readonly string[] | undefined;
  /** Reveal a vault value on a terminal. */
  readonly show?: boolean | undefined;
  /** Print only the value, for `$(…)`. */
  readonly raw?: boolean | undefined;
  /** Skip the confirmation a destructive command would otherwise ask for. */
  readonly yes?: boolean | undefined;
}

export async function withRuntime(
  flags: OwnerFlags,
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> {
  const runtime = await openRuntime(flags);
  try {
    // Every command announces its profile and target before acting — except
    // under `--raw`, whose entire purpose is that `$(…)` captures the value and
    // nothing else. The same exception `lanes link token show --raw` makes.
    if (!flags.raw) announce(runtime.resolution);
    await body(runtime);
  } finally {
    await runtime.close();
  }
}

/**
 * Which connection of an owner provider to act on.
 *
 * A profile usually has exactly one of each, and typing `--connection` to reach
 * your only one would be pure ceremony — the same trade ADR-012 §1 made for
 * prompt routing. Two or more is genuinely ambiguous, so it refuses and names
 * the candidates rather than picking.
 */
export function ownerConnection(config: Config, provider: string, flags: OwnerFlags): string {
  // Derived from the grants, not from the workspace's connections. The question
  // is which store *this profile* may reach, and a workspace holding
  // `memory.acme` that this profile does not grant is not a candidate — offering
  // it would let the CLI write somewhere the endpoint would refuse to read
  // (ADR-057, ADR-058).
  const prefix = `${provider}.`;
  const candidates = config.grants
    .filter((grant) => grant.connection.startsWith(prefix))
    .map((grant) => ({ id: grant.connection.slice(prefix.length) }));

  if (flags.connection) {
    const match = candidates.find((connection) => connection.id === flags.connection);
    if (!match) {
      throw new ConfigError(
        `No ${provider} connection "${flags.connection}" in this profile` +
          (candidates.length > 0
            ? ` (have: ${candidates.map((connection) => connection.id).join(', ')})`
            : ''),
      );
    }
    return match.id;
  }

  if (candidates.length === 0) {
    throw new ConfigError(
      `This profile grants no ${provider} connection.\n` +
        `  Connect one to the workspace, then grant it:\n` +
        `    lanes link connect ${provider}\n` +
        `    lanes link grant ${provider}.<id> --profile ${config.instance.profile}`,
    );
  }
  if (candidates.length > 1) {
    throw new ConfigError(
      `This profile has ${candidates.length} ${provider} connections ` +
        `(${candidates.map((connection) => connection.id).join(', ')}). Name one with --connection.`,
    );
  }

  return candidates[0]!.id;
}

/**
 * Read a value from stdin, refusing a terminal.
 *
 * The same shape as `lanes link secrets set`, for the same two reasons: a value on argv
 * lands in shell history, and a command that silently waits on a terminal that
 * will never send anything is a hang rather than an error.
 */
export async function readStdin(usage: string, what: string): Promise<string> {
  if (process.stdin.isTTY) {
    throw new ConfigError(
      `${usage} reads ${what} from stdin, and stdin is a terminal.\n` +
        `  printf %s "<value>" | ${usage}\n` +
        `  or: ${usage} < file.md`,
    );
  }

  const text = (await Bun.stdin.text()).replace(/\n$/, '');
  if (!text) throw new ConfigError(`Nothing on stdin. Pipe ${what} in:  ${usage} < file`);
  return text;
}

/**
 * Read stdin where there may legitimately be nothing on it.
 *
 * `readStdin` refuses both a terminal and an empty pipe, which is right for
 * `memory write` and `vault set` — a command whose whole subject arrived empty
 * has been mis-invoked. It is wrong for `tasks add`, whose subject is the title
 * on argv and whose notes are optional: refusing there made
 * `lanes link tasks add "x"` fail in every non-interactive context — a script, a
 * cron, a `< /dev/null` — while working by hand, which is the worst shape for a
 * bug to have.
 */
export async function optionalStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  return (await Bun.stdin.text()).replace(/\n$/, '');
}

/** Confirm a destructive action, unless `--yes` already answered. */
export async function agreed(flags: OwnerFlags, question: string): Promise<boolean> {
  if (flags.yes) return true;

  if (!process.stdin.isTTY) {
    throw new ConfigError(
      `${question} — stdin is not a terminal, so there is nobody to ask. Pass --yes to proceed.`,
    );
  }

  // Defaulting to no: the same choice `connect` makes where a prompt precedes
  // something that cannot be undone.
  const yes = await confirm(question, false);
  if (!yes) print(style.dim('  cancelled'));
  return yes;
}

export function required(value: string | undefined, usage: string): string {
  if (!value) throw new ConfigError(`Usage: ${usage}`);
  return value;
}
