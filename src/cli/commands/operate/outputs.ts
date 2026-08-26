import { listProfiles } from '#profile';
import { unservableProfiles } from '#deployments/servable.ts';
import { fileURLToPath } from 'node:url';
import { deployedUrl, endpointHealth, localUrl } from '../../endpoint-url.ts';
import { announce, heading, print, style, warn } from '../../output.ts';
import { ensureProfileToken, openRuntime, type GlobalFlags } from '../../runtime.ts';

export interface OutputsFlags extends GlobalFlags {
  readonly show?: boolean | undefined;
  readonly json?: boolean | undefined;
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
    // Not `endpointUrl`, which would ask the platform a second time for an
    // answer this line already has.
    const url = deployed ?? localUrl(runtime.config);

    const live = await endpointHealth(url, token);
    const mine = live?.profile === runtime.resolution.profile;

    // Live if it is up, otherwise what `start` would serve — which is every
    // profile in the workspace *that declares this target*, not every profile
    // full stop. `start` opens them all against one target and skips the ones
    // that cannot run on it, so listing those here would promise a reach the
    // endpoint will not have.
    const profiles = mine
      ? live.profiles
      : await servable(runtime.resolution.workspaceRoot, runtime.target);

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

    const invocation = await tokenInvocation(
      token,
      runtime.resolution.profile,
      runtime.resolution.target,
    );

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

/** The profiles a `start` on this target would actually open. */
async function servable(workspaceRoot: string, target: string): Promise<string[]> {
  const all = await listProfiles(workspaceRoot);
  const cannot = new Set(
    (await unservableProfiles({ workspaceRoot, profiles: undefined, target })).map(
      (one) => one.profile,
    ),
  );

  return all.filter((name) => !cannot.has(name));
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
export async function tokenInvocation(
  expected: string,
  profile: string,
  target: string,
): Promise<{ command: string; onPath: boolean }> {
  // Both, always, and from the *resolved* selection rather than the flags. A
  // token is per-target, so `outputs --target cloud` printing a bare
  // `token show --raw` hands over the local one beside a deployed URL — a
  // credential that looks like an answer and fails as a wrong password. Naming
  // the profile as well makes the line pasteable into any shell rather than
  // only into one where the same default happens to resolve.
  const selection = ` --profile ${profile} --target ${target}`;
  const short = `lanes link token show --raw${selection}`;
  const argv = ['link', 'token', 'show', '--raw', '--profile', profile, '--target', target];

  const resolved = Bun.which('lanes');
  if (resolved) {
    try {
      const result = Bun.spawnSync([resolved, ...argv]);
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
  return { command: `bun run ${entry} link token show --raw${selection}`, onPath: false };
}

