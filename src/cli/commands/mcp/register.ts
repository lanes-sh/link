import { endpointUrl } from '../../endpoint-url.ts';
import { fail, ok, print, style, warn } from '../../output.ts';
import { ensureProfileToken, openRuntime, type GlobalFlags } from '../../runtime.ts';
import { installFor } from './assets.ts';
import { HARNESSES, type AddInput, type Harness } from './harnesses.ts';

/**
 * `lanes link mcp add [harness]` — register this endpoint with an agent, and
 * give that agent the document that says what it is for.
 *
 * The registration half does **not** write to any agent's config file. It runs
 * the harness's own supported command, which keeps the registration format the
 * harness's business. If either CLI changes, this breaks loudly rather than
 * writing a stale format.
 *
 * The install half does write a file, because no harness has a command for it
 * (ADR-016). Those are different risks: a registration we spelled wrong is a
 * config file we corrupted, and a skill we spelled wrong is a Markdown document
 * in a directory named after us.
 *
 * The manual command from `lanes link outputs` remains the canonical path. This
 * exists because typing it correctly turns out to be error-prone: an em-dash
 * from a paste, or a `lanes` not on PATH substituting to an empty token,
 * both produce a 401 that reads as a bad credential.
 */

export interface McpAddOptions extends GlobalFlags {
  readonly name?: string | undefined;
  readonly scope?: string | undefined;
  readonly tokenEnv?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly force?: boolean | undefined;
  /** Register only; leave the skill and the agent alone. */
  readonly noSkill?: boolean | undefined;
}

export async function mcpAdd(target: string | undefined, options: McpAddOptions): Promise<void> {
  // No harness named: every one that is actually installed. Registering with
  // whatever is present is what someone means by "add my mcp", and naming one
  // stays available for the case where it is not.
  const chosen = target
    ? HARNESSES.filter((harness) => harness.id === target)
    : HARNESSES.filter((harness) => Bun.which(harness.binary));

  if (target && chosen.length === 0) {
    throw new Error(
      `Unknown harness "${target}". Known: ${HARNESSES.map((h) => h.id).join(', ')}.\n` +
        '  For anything else, "lanes link outputs" prints the URL and token to register by hand.',
    );
  }

  if (chosen.length === 0) {
    throw new Error(
      `None of ${HARNESSES.map((h) => h.binary).join(', ')} is on your PATH, so there is nothing to run.\n` +
        '  Run "lanes link outputs" and register by hand instead.',
    );
  }

  const name = options.name ?? 'lanes-link';
  // User scope, not project scope.
  //
  // This registers a gateway to someone's *accounts* — their mail, calendar,
  // files. Claude Code's `local` scope binds a server to one directory, so a
  // project-scoped registration means your inbox is reachable from
  // ~/dev/thing and not from ~/dev/other, which nobody expects and nothing
  // about the endpoint suggests. `local` is right for a repository's own
  // tooling; it is wrong for this.
  const scope = options.scope ?? 'user';
  const tokenEnv = options.tokenEnv ?? 'LANES_LINK_TOKEN';

  const runtime = await openRuntime(options);

  try {
    const { token } = await ensureProfileToken(runtime.credentials, runtime.config.auth.token_ref);

    // The target's own address, not the local one. This built
    // `http://<host>:<port>/mcp` unconditionally, so `mcp add --target cloud`
    // registered loopback with the agent: a registration that reports success,
    // names the right server, and points at a port with nothing behind it.
    const url = await endpointUrl(runtime.config, runtime.target);
    const input: AddInput = { name, url, token, tokenEnv, scope };

    // Registering an endpoint that is down is legitimate — the harness stores
    // the address and connects on demand — but it is usually a mistake worth
    // mentioning, since the first symptom is a failed tool call much later.
    if (!(await reachable(url))) {
      const start = url.startsWith('http://127.') || url.startsWith('http://localhost')
        ? 'run "lanes link start" before using it'
        : 'the deployed service is not answering — check "lanes link outputs"';
      print(warn(`nothing is answering on ${url} — ${start}`));
    }

    for (const harness of chosen) await register(harness, input, options);
  } finally {
    await runtime.close();
  }
}

async function register(
  harness: Harness,
  input: AddInput,
  options: McpAddOptions,
): Promise<void> {
  const binary = Bun.which(harness.binary);
  if (!binary) {
    print(fail(`${harness.label} ("${harness.binary}") is not on your PATH`));
    return;
  }

  const args = harness.add(input);

  if (options.dryRun) {
    // The token is redacted here and only here: a dry run exists precisely so
    // someone can read the command before it carries a live credential.
    print(`  ${harness.binary} ${redactToken(args).map(quote).join(' ')}`);
    if (!options.noSkill) await installFor(harness, input.scope, { dryRun: true });
    return;
  }

  if (exists(binary, harness, input.name)) {
    if (!options.force) {
      print(warn(`${harness.label}: "${input.name}" is already registered`));
      print(style.dim('    --force replaces it, e.g. after "lanes link token rotate"'));
      // The documents are still refreshed. Someone re-running this after an
      // upgrade wants the current skill, and refusing to update it because the
      // registration was already right is the opposite of what they asked for.
      if (!options.noSkill) await installFor(harness, input.scope, {});
      return;
    }
    // Remove then add: both CLIs refuse a duplicate name rather than updating,
    // and a stale token is the usual reason anyone is here.
    Bun.spawnSync([binary, ...harness.remove(input.name)], { stdout: 'ignore', stderr: 'ignore' });
  }

  const result = Bun.spawnSync([binary, ...args], { stdout: 'pipe', stderr: 'pipe' });

  if (!result.success) {
    print(fail(`${harness.label}: ${harness.binary} exited ${result.exitCode}`));
    const stderr = new TextDecoder().decode(result.stderr).trim();
    if (stderr) print(style.dim(`    ${stderr}`));
    process.exitCode = 1;
    return;
  }

  print(
    ok(
      `registered ${style.bold(input.name)} with ${harness.label}` +
        (harness.scoped ? ` (${input.scope} scope)` : ''),
    ),
  );
  print(`      ${input.url}`);

  if (!options.noSkill) await installFor(harness, input.scope, {});

  if (harness.storesToken) {
    print(
      style.dim(
        '      The token was stored as a value, not a command, so "lanes link token rotate"\n' +
          '      means running this again with --force.',
      ),
    );
  }

  const after = harness.afterAdd?.(input);
  if (after) {
    print('');
    for (const line of after) print(line ? `      ${line}` : '');
  }
}

/** Whether the harness already knows this name, so we replace rather than fail. */
export function exists(binary: string, harness: Harness, name: string): boolean {
  return Bun.spawnSync([binary, ...harness.get(name)], {
    stdout: 'ignore',
    stderr: 'ignore',
  }).success;
}

async function reachable(url: string): Promise<boolean> {
  try {
    const health = new URL(url);
    health.pathname = '/health';
    return (await fetch(health, { signal: AbortSignal.timeout(700) })).ok;
  } catch {
    return false;
  }
}

/** Quote an argument a shell would otherwise split, so a dry run is pasteable. */
function quote(argument: string): string {
  return /[\s"'$`\\]/.test(argument) ? `"${argument.replace(/(["$`\\])/g, '\\$1')}"` : argument;
}

/** Replace the bearer value, so a dry run can be pasted into a bug report. */
function redactToken(args: readonly string[]): string[] {
  return args.map((argument) =>
    argument.startsWith('Authorization: Bearer ') ? 'Authorization: Bearer <token>' : argument,
  );
}
