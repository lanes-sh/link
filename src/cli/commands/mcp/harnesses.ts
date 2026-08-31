import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The agent harnesses this CLI knows how to set up, and the two different
 * things "setting up" means.
 *
 * **Registration is delegated.** `add`, `get`, and `remove` are argument lists
 * for the harness's *own* command, because where Claude Code and Codex keep
 * their servers, and what belongs in those files, is not ours to define. If
 * either CLI changes shape, this breaks loudly rather than writing a stale
 * format.
 *
 * **Assets are written.** `skills` and `agents` name directories we put a
 * document in, because there is no `claude skill add` to delegate to. The line
 * between the two is the whole of ADR-016: delegate where the harness owns a
 * command, write the file where it does not. A skill is content in a documented
 * location, not a config format we would be guessing at, and the directory
 * written is named after this project.
 *
 * **No registration carries a token any more** (ADR-062). Every endpoint runs
 * the authorization flow, discovery is served ahead of the auth gate on
 * loopback as well as deployed, and a client pointed at a bare URL finds
 * `/.well-known/oauth-protected-resource`, signs its owner in at lanes.sh, and
 * comes back with a token of its own. What that removes is worth stating: the
 * registration no longer contains a credential, so a config file synced to a
 * dotfiles repository is no longer a leak, and a rotation does not invalidate
 * every harness at once.
 *
 * The exception is `tokenEnv`, which survives for the one caller that has no
 * browser — see `token show`, which is now documented as a CI command.
 */

export interface AddInput {
  readonly name: string;
  readonly url: string;
  /**
   * The endpoint's static token, for a harness that cannot run a browser.
   *
   * Nothing passes this in the ordinary path. It is here because
   * `--headless` exists for CI, where there is no browser to complete an
   * authorization in and a pasted credential is the only thing that works.
   */
  readonly token?: string | undefined;
  readonly tokenEnv: string;
  readonly scope: string;
  /**
   * Which selection this registration is for.
   *
   * Not part of the URL — a deployed endpoint serves every profile in its bucket
   * and each call names one. It is here because the shell commands a harness is
   * told to run afterwards do need it, and a `lanes link token show` without it
   * substitutes to nothing.
   */
  readonly profile: string;
  readonly target: string;
}

export interface Harness {
  readonly id: string;
  readonly binary: string;
  readonly label: string;
  /** Whether `--scope` means anything here. Codex config is global. */
  readonly scoped: boolean;
  /**
   * Whether a credential reaches the harness's config at all.
   *
   * Both are `false` in the ordinary path now — the client authorises itself.
   * This still distinguishes what a `--headless` registration would write:
   * Claude Code would hold the header value, and Codex stores only the *name*
   * of an environment variable it reads at launch.
   */
  readonly storesToken: boolean;
  /**
   * This harness's configuration directory, honouring its own override.
   *
   * Read at call time rather than captured, because a test sets the variable
   * around the call and a value resolved at import would be the real home.
   */
  home(): string;
  add(input: AddInput): string[];
  get(name: string): string[];
  remove(name: string): string[];
  /** Where user- or project-scope skills go, if this harness reads any. */
  skills?(scope: string): string;
  /** Where subagent definitions go. Codex has no equivalent. */
  agents?(scope: string): string;
  /** Anything the operator still has to do themselves. */
  afterAdd?(input: AddInput): string[];
}

/**
 * A scoped directory under a harness's home.
 *
 * `user` is the home itself; anything else is the project-local `.<harness>`
 * directory beside the code, which is where both Claude Code scopes that are
 * not `user` look. Resolved against the current directory deliberately — a
 * project-scope install belongs to the checkout someone is standing in.
 */
function scoped(home: string, dotDirectory: string, scope: string, kind: string): string {
  return scope === 'user' ? join(home, kind) : join(process.cwd(), dotDirectory, kind);
}

const CLAUDE_HOME = (): string => process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude');
const CODEX_HOME = (): string => process.env['CODEX_HOME'] ?? join(homedir(), '.codex');

export const HARNESSES: readonly Harness[] = [
  {
    id: 'claude',
    binary: 'claude',
    label: 'Claude Code',
    scoped: true,
    storesToken: true,
    home: CLAUDE_HOME,
    add: ({ name, url, token, scope }) => [
      'mcp',
      'add',
      '--transport',
      'http',
      name,
      url,
      // Only when there is no browser to sign in with. Registering the bare URL
      // is the ordinary path: Claude Code discovers the protected-resource
      // document and runs the authorization itself.
      ...(token ? ['--header', `Authorization: Bearer ${token}`] : []),
      '--scope',
      scope,
    ],
    // No scope on get: it looks across all of them, which is what we want —
    // a name registered at user scope still collides with a local-scope add.
    get: (name) => ['mcp', 'get', name],
    // No scope on remove either: "removes from whichever scope it exists in",
    // so a user-scope registration cannot survive a local-scope --force.
    remove: (name) => ['mcp', 'remove', name],
    skills: (scope) => scoped(CLAUDE_HOME(), '.claude', scope, 'skills'),
    agents: (scope) => scoped(CLAUDE_HOME(), '.claude', scope, 'agents'),
  },
  {
    id: 'codex',
    binary: 'codex',
    label: 'Codex',
    scoped: false,
    storesToken: false,
    home: CODEX_HOME,
    add: ({ name, url, tokenEnv }) => [
      'mcp',
      'add',
      name,
      '--url',
      url,
      '--bearer-token-env-var',
      tokenEnv,
    ],
    get: (name) => ['mcp', 'get', name],
    remove: (name) => ['mcp', 'remove', name],
    // Same layout and the same frontmatter Claude Code reads, so one document
    // installs to both unchanged. Codex has no subagent directory, so it gets
    // the skill and not the scout — and `mcp add` says which it did.
    skills: () => join(CODEX_HOME(), 'skills'),
    afterAdd: ({ tokenEnv, profile, target }) => [
      `Codex reads the token from $${tokenEnv} when it starts, so set it where Codex will see it:`,
      '',
      // Both flags, and this line is the reason they matter more here than
      // anywhere else: an unresolvable substitution yields the empty string, the
      // header becomes "Bearer ", and the only symptom is a 401 that reads as a
      // bad token rather than a command that refused.
      `    export ${tokenEnv}="$(lanes link token show --raw --profile ${profile} --workspace ${target})"`,
      '',
      'Add that to your shell profile. This is the better half of the bargain: the token never',
      'reaches ~/.codex/config.toml, and a "lanes link token rotate" is picked up on next launch',
      'with no re-registration.',
    ],
  },
];

/** The command shapes, exposed so a test can pin them against each CLI's help. */
export function harnessCommands(id: string): Harness | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
