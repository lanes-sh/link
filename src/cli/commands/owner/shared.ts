import { ConfigError, type Config } from '#profile';
import { announce, print, style } from '../../output.ts';
import { confirm } from '../../prompt.ts';
import { openRuntime, type GlobalFlags, type Runtime } from '../../runtime.ts';

/**
 * What `lanes link memory`, `lanes link skills` and `lanes link vault` all need: the flag shape, the
 * runtime wrapper, connection resolution, and the two prompts.
 *
 * All four commands are the same shape — open a runtime, announce, act, close —
 * so the wrapper lives here rather than three times over.
 */

export interface OwnerFlags extends GlobalFlags {
  /** Which connection of this provider, when a profile has more than one. */
  readonly connection?: string | undefined;
  readonly title?: string | undefined;
  readonly tag?: string | undefined;
  readonly description?: string | undefined;
  readonly file?: string | undefined;
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
  const candidates = config.connections.filter((connection) => connection.provider === provider);

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
      `This profile has no ${provider} connection. Add one with: lanes link connect ${provider}`,
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
