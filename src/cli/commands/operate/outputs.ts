import { listProfiles } from '#profile';
import { fileURLToPath } from 'node:url';
import { deployedUrl, endpointUrl } from '../../endpoint-url.ts';
import { announce, heading, print, style, warn } from '../../output.ts';
import { ensureProfileToken, openRuntime, type GlobalFlags } from '../../runtime.ts';

export interface OutputsFlags extends GlobalFlags {
  readonly show?: boolean | undefined;
  readonly json?: boolean | undefined;
}

interface Health {
  readonly profile: string;
  readonly profiles: readonly string[];
}

/**
 * What an agent harness needs to reach this endpoint.
 *
 * The unit here is the **endpoint**, not the profile. One `lanes link start`
 * serves every profile in the workspace from one URL under one token, so
 * printing a registration per profile — which this did while the ports were
 * per profile — now emits commands that authenticate against tokens the server
 * does not accept.
 *
 * Deliberately not a registration command that runs: nothing here writes to any
 * agent's config file, because which file that is, and what belongs in it, is
 * the harness's business.
 */
export async function outputs(flags: OutputsFlags): Promise<void> {
  const runtime = await openRuntime(flags);

  try {
    const { token } = await ensureProfileToken(runtime.credentials, runtime.config.auth.token_ref);
    const declared = runtime.config.targets[runtime.target]?.deploy;
    const deployed = await deployedUrl(declared);
    const url = deployed ?? (await endpointUrl(runtime.config, runtime.target));

    const live = await health(url, token);
    const mine = live?.profile === runtime.resolution.profile;

    // Live if it is up, otherwise what `start` would serve: the whole
    // workspace, since `--only` is the exception rather than the default.
    const profiles = mine
      ? live.profiles
      : await listProfiles(runtime.resolution.workspaceRoot);

    if (flags.json) {
      print(
        JSON.stringify(
          {
            url,
            running: mine,
            deployed: deployed !== null,
            target: runtime.target,
            primary: runtime.resolution.profile,
            profiles,
            ...(flags.show ? { token } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    announce(runtime.resolution);

    heading('Endpoint');
    print(
      `  ${url}  ${mine ? style.green(deployed ? 'deployed' : 'running') : style.dim(deployed ? 'not answering' : 'not running')}`,
    );
    if (deployed && declared) {
      // The URL is the platform's, not the configured host and port: those
      // govern where `lanes link start` listens locally and mean nothing to a
      // deployed revision, which listens on whatever $PORT it was given.
      print(style.dim(`  ${declared.platform} service "${declared.service}" for target "${runtime.target}".`));
    }

    if (live && !mine) {
      // Two workspaces can assign the same port. Saying so beats reporting an
      // endpoint as up when it belongs to something else entirely.
      print(warn(`something else is serving this port: profile "${live.profile}"`));
    }

    heading(`Profiles reachable through it (${profiles.length})`);
    for (const profile of profiles) {
      print(`  ${profile}${profile === runtime.resolution.profile ? style.dim('  (endpoint owner)') : ''}`);
    }
    print(style.dim('  Each call names one, in its `profile` argument.'));

    if (flags.show) {
      heading('Token');
      print(`  ${token}`);
    }

    heading('Register with your agent');
    print(
      style.dim(
        '  Not run for you: which config file an agent reads is its business, not ours.',
      ),
    );
    print('');

    const invocation = await tokenInvocation(runtime.config.auth.token_ref, token, flags.profile);

    print(
      `  claude mcp add --transport http lanes-link ${url} \\\n` +
        `    --header "Authorization: Bearer $(${invocation.command})"`,
    );
    print('');

    if (!invocation.onPath) {
      // The failure this prevents is nasty: an unresolvable command substitutes
      // to the empty string, the header becomes "Bearer ", and the only symptom
      // is a 401 that looks like a bad token rather than a missing binary.
      print(warn('lanes is not on your PATH, so the short form would substitute to nothing.'));
      print(style.dim('  The command above uses this checkout instead. To shorten it permanently:'));
      print(`      cd ${process.cwd()} && bun link`);
      print('');
    }

    print(
      style.dim(
        '  One registration covers every profile above. The $(…) keeps the token out of your\n' +
          '  agent\'s context and out of the transcript — but note it is resolved once, when you\n' +
          '  run the command, and stored as a literal. After "lanes link token rotate" you have to\n' +
          '  register again. Other harnesses take the same two facts — URL and bearer token.',
      ),
    );
  } finally {
    await runtime.close();
  }
}

/**
 * The command that prints this endpoint's token, verified to actually work.
 *
 * `$(lanes link token show --raw)` is the right shape, and useless if `lanes`
 * does not resolve: the substitution yields an empty string, the header becomes
 * `Bearer `, and the endpoint answers 401 — which reads as a bad token rather
 * than a missing binary. So the short form is offered only after running it and
 * checking it returns *this* token; otherwise the printed command names this
 * checkout, which always works.
 */
async function tokenInvocation(
  tokenRef: string,
  expected: string,
  profile: string | undefined,
): Promise<{ command: string; onPath: boolean }> {
  const suffix = profile ? ` --profile ${profile}` : '';
  const short = `lanes link token show --raw${suffix}`;

  const resolved = Bun.which('lanes');
  if (resolved) {
    try {
      const result = Bun.spawnSync([resolved, 'link', 'token', 'show', '--raw', ...(profile ? ['--profile', profile] : [])]);
      // Compared against the token rather than merely checking it exited zero:
      // a `lanes` on PATH could belong to a different workspace entirely,
      // and would hand the harness a token this endpoint rejects.
      if (result.success && new TextDecoder().decode(result.stdout).trim() === expected) {
        return { command: short, onPath: true };
      }
    } catch {
      // Falls through to the checkout-relative form.
    }
  }

  // `lanes.ts`, not `main.ts`: main.ts exports `run` and no longer executes on
  // import, so `bun run main.ts token show --raw` prints nothing and exits 0 —
  // which is the empty-token failure this whole function exists to avoid,
  // reintroduced by the fallback meant to prevent it.
  const entry = fileURLToPath(new URL('../../lanes.ts', import.meta.url));
  return { command: `bun run ${entry} link token show --raw${suffix}`, onPath: false };
}

/**
 * Ask the endpoint who it is.
 *
 * The profile name is checked by the caller, not just the port: two workspaces
 * can assign the same port, and reporting "running" because something
 * unrelated answers would send someone to register an endpoint serving another
 * workspace's accounts.
 *
 * The token is sent because `/health` names profiles only to a caller that
 * holds one. Anonymously it answers `{status: "ok"}` and nothing else — that
 * list is what this endpoint holds, and a deployed URL is readable by anyone.
 * An endpoint that answers without naming itself is therefore reported as
 * something else's, which is the honest reading: this token does not open it.
 */
async function health(url: string, token: string): Promise<Health | null> {
  try {
    const probe = new URL(url);
    probe.pathname = '/health';
    const response = await fetch(probe, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(700),
    });
    if (!response.ok) return null;

    const body = (await response.json()) as Partial<Health>;
    return body.profile ? { profile: body.profile, profiles: body.profiles ?? [body.profile] } : null;
  } catch {
    return null;
  }
}
