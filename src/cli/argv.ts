import type { GlobalFlags } from './runtime.ts';
import type { OwnerFlags } from './commands/owner.ts';
import type { KnowledgeFlags } from './commands/knowledge.ts';
import type { CustomFlags } from './commands/connect/custom/spec.ts';

/**
 * Turning argv into a command path and a flag bag.
 *
 * Hand-rolled rather than delegated to a framework: the grammar is small, and a
 * dependency that parses argv in a process that also holds credential-store
 * keys is not worth the convenience.
 *
 * Separate from `main.ts` so it can be tested. While the parser lived inside
 * the bin entry it was unreachable — importing the module ran the CLI.
 */

export type Flags = Record<string, string | boolean>;

export interface Parsed {
  readonly command: string[];
  readonly flags: Flags;
}

export function parseArgv(argv: readonly string[]): Parsed {
  const command: string[] = [];
  const flags: Flags = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;

    if (!argument.startsWith('--')) {
      command.push(argument);
      continue;
    }

    const body = argument.slice(2);
    const equals = body.indexOf('=');

    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1);
      continue;
    }

    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next;
      index++;
    } else {
      flags[body] = true;
    }
  }

  return { command, flags };
}

/**
 * A flag's value, when it was given one.
 *
 * `--profile` with nothing after it parses to `true`, which is not a profile
 * name — so every string-valued flag has to check, and this is that check
 * written once.
 */
export function text(flags: Flags, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Every value given for a flag, in order.
 *
 * `profile add --target local --target cloud` is the one command where a flag
 * legitimately repeats: it is declaring a list, not selecting one thing. The
 * parser keeps the last value in `flags`, so this re-reads argv rather than
 * changing that shape for every other flag's sake.
 */
export function all(argv: readonly string[], name: string): string[] {
  const values: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) values.push(next);
      continue;
    }
    if (token.startsWith(`--${name}=`)) values.push(token.slice(name.length + 3));
  }

  // Comma-separated is the other spelling people reach for, and refusing it
  // would be a refusal with no reason behind it.
  return values.flatMap((value) => value.split(',').map((part) => part.trim())).filter(Boolean);
}

/** The flags every command accepts. */
export function globalFlags(flags: Flags): GlobalFlags {
  return {
    profile: text(flags, 'profile'),
    target: text(flags, 'target'),
    quiet: flags['quiet'] === true,
  };
}

/**
 * The owner layer's flags — the global set plus what `memory`, `skills` and
 * `vault` add.
 *
 * The kebab-case spellings live here and nowhere else, so the one place that
 * knows `--display-name` is the one place that parses argv.
 */
export function ownerFlags(flags: Flags): OwnerFlags {
  return {
    ...globalFlags(flags),
    show: flags['show'] === true,
    raw: flags['raw'] === true,
    connection: text(flags, 'connection'),
    title: text(flags, 'title'),
    tag: text(flags, 'tag'),
    description: text(flags, 'description'),
    file: text(flags, 'file'),
    yes: flags['yes'] === true,
  };
}

/**
 * `lanes link knowledge`'s flags.
 *
 * Here for the reason `ownerFlags` is: the kebab-case spellings belong in the
 * one place that parses argv, so `--allow-public` is written once rather than
 * once per reader.
 */
export function knowledgeFlags(flags: Flags): KnowledgeFlags {
  return {
    ...globalFlags(flags),
    repo: text(flags, 'repo'),
    branch: text(flags, 'branch'),
    path: text(flags, 'path'),
    // `--migrate`, `--no-migrate`, or neither — see `KnowledgeFlags.migrate`.
    migrate: flags['migrate'] === true ? true : flags['no-migrate'] === true ? false : undefined,
    keep: flags['keep'] === true,
    allowPublic: flags['allow-public'] === true,
    replace: flags['replace'] === true,
    yes: flags['yes'] === true,
    json: flags['json'] === true,
  };
}

/**
 * `lanes link connect custom`'s flags.
 *
 * Here for the reason `ownerFlags` and `knowledgeFlags` are: the kebab-case
 * spellings belong in the one place that parses argv. The list flags go through
 * `all(argv, …)` rather than through `flags`, because `parseArgv` keeps only the
 * last value of a repeated flag — so `--scopes a --scopes b` would silently
 * become `b`, and a scope quietly dropped is a token that works until it does
 * not.
 *
 * Which of these are read at all depends on the connectivity type and the
 * credential type chosen; that is `custom/spec.ts`'s to know. This only spells
 * them.
 */
export function customFlags(flags: Flags, argv: readonly string[]): CustomFlags {
  return {
    connector: text(flags, 'connector'),
    auth: text(flags, 'auth'),
    name: text(flags, 'name'),
    description: text(flags, 'description'),
    endpoint: text(flags, 'endpoint'),
    baseUrl: text(flags, 'base-url'),
    openapi: text(flags, 'openapi'),
    operations: all(argv, 'operations'),
    service: text(flags, 'service'),
    host: text(flags, 'host'),
    port: text(flags, 'port'),
    smtpHost: text(flags, 'smtp-host'),
    smtpPort: text(flags, 'smtp-port'),
    root: text(flags, 'root'),
    exclude: all(argv, 'exclude'),
    authHeader: text(flags, 'auth-header'),
    authQuery: text(flags, 'auth-query'),
    scopes: all(argv, 'scopes'),
    authorizeUrl: text(flags, 'authorize-url'),
    tokenUrl: text(flags, 'token-url'),
    clientApp: text(flags, 'client-app'),
    registration: text(flags, 'registration'),
    identityUrl: text(flags, 'identity-url'),
    identityField: text(flags, 'identity-field'),
    setupDocs: text(flags, 'setup-docs'),
    replaceManifest: flags['replace-manifest'] === true,
    yes: flags['yes'] === true,
  };
}
