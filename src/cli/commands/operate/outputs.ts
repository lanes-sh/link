import { anyIssuedToken, listProfiles } from '#profile';
import { fileURLToPath } from 'node:url';
import { deployedUrl, endpointHealth, localUrl } from '../../endpoint-url.ts';
import { announceWorkspace, heading, print, style, warn } from '../../output.ts';
import { openWorkspaceRuntime, type GlobalFlags } from '../../runtime.ts';

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
  // The workspace, matching what this command's own subject has always been
  // (ADR-068). It asked for a profile only to find the endpoint's token, and
  // that token is the workspace's.
  const runtime = await openWorkspaceRuntime(flags);

  try {
    // Whatever has been issued, or nothing — which is the ordinary state.
    // Nothing is minted: `outputs` reports, and a token names a person.
    const held = await anyIssuedToken(runtime.resolution.workspaceRoot, runtime.credentials);
    const token = held?.value;
    const declared = runtime.declared.deploy;
    const deployed = await deployedUrl(declared);
    // Not `endpointUrl`, which would ask the platform a second time for an
    // answer this line already has.
    const url = deployed ?? localUrl(runtime.config);

    // Unauthenticated when nothing is issued. `/health` answers either way; what
    // it withholds without a credential is the profile list, so `mine` below is
    // then decided by the endpoint answering at all.
    const live = await endpointHealth(url, token);
    const mine = live !== null;

    // Live if it is up, otherwise every profile in this target's workspace.
    // Those are the same set now: a profile lives in exactly one target
    // (ADR-052), so every profile here is one this target can open. The filter
    // that used to sit between them answered "which of these declare it", a
    // question no profile has an opinion on any more.
    const profiles = mine ? live.profiles : await listProfiles(runtime.resolution.workspaceRoot);

    if (flags.json) {
      print(
        JSON.stringify(
          {
            url,
            running: mine,
            deployed: deployed !== null,
            target: runtime.target,
            profiles,
            ...(flags.show && token !== undefined ? { token } : {}),
          },
          null,
          2,
        ),
      );
      return;
    }

    announceWorkspace(runtime.resolution);

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

    heading(`Profiles served by it (${profiles.length})`);
    for (const profile of profiles) print(`  ${profile}`);
    print(
      style.dim(
        '  Each call names one, in its `profile` argument. Which of these a client\n' +
          '  actually reaches is decided by who signs in — every profile whose members\n' +
          '  list them, and no others.',
      ),
    );

    if (flags.show && token !== undefined) {
      heading('Token');
      print(`  ${token}  ${style.dim(`(${held?.id})`)}`);
    }

    heading('Register with your agent');
    print(
      style.dim(
        '  Not run for you: which config file an agent reads is its business, not ours.',
      ),
    );
    print('');

    // **The bare URL, and no header** (ADR-062). This printed the
    // `Authorization: Bearer $(…)` form unconditionally, which was the shape
    // before every endpoint ran the authorization flow — a registration that
    // carries a credential, bypasses consent and expiry, and leaves a long-lived
    // token in a harness config. The client discovers
    // `/.well-known/oauth-protected-resource` from the 401 and signs its owner
    // in instead.
    print(`  claude mcp add --transport http lanes-link ${url}`);
    print('');
    print(
      style.dim(
        '  No credential goes into that command. The client reads this endpoint\'s\n' +
          '  protected-resource document, sends its owner to sign in, and comes back\n' +
          '  holding a token of its own — so a config file synced to a dotfiles repo\n' +
          '  is not a leak, and rotating a static token does not invalidate it.',
      ),
    );

    heading('For a machine with no browser');
    if (token === undefined) {
      print(style.dim('  No static token is issued in this workspace.'));
      print(
        style.dim(
          `      lanes link token issue --me --workspace ${runtime.target}\n` +
            '  It reaches the profiles that list your subject as a member, and nothing else.',
        ),
      );
    } else {
      const invocation = await tokenInvocation(runtime.resolution.target);
      print(
        `  claude mcp add --transport http lanes-link ${url} \\\n` +
          `    --header "Authorization: Bearer $(${invocation.command})"`,
      );
      print('');
      if (!invocation.onPath) {
        // The failure this prevents is nasty: an unresolvable command
        // substitutes to the empty string, the header becomes "Bearer ", and
        // the only symptom is a 401 that looks like a bad token rather than a
        // missing binary.
        print(warn('lanes is not on your PATH, so the short form would substitute to nothing.'));
        print(style.dim('  The command above uses this checkout instead. To shorten it permanently:'));
        print(`      cd ${process.cwd()} && bun link`);
        print('');
      }
      print(
        style.dim(
          '  CI only, and it is narrower than it looks: the token reaches the profiles\n' +
            '  its subject is a member of. The $(…) keeps it out of your agent\'s context\n' +
            '  and out of the transcript, but it resolves once and is stored as a literal —\n' +
            '  so a rotate means registering again.',
        ),
      );
    }
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
export async function tokenInvocation(
  target: string,
): Promise<{ command: string; onPath: boolean }> {
  // `--workspace`, always, and from the *resolved* selection rather than the
  // flags. A token is per-workspace, so `outputs --workspace cloud` printing a
  // bare `token show --raw` hands over the local one beside a deployed URL — a
  // credential that looks like an answer and fails as a wrong password.
  //
  // No `--profile` any more (ADR-068): `token show` refuses one, so printing it
  // here would emit a line that cannot be pasted.
  const selection = ` --workspace ${target}`;
  const short = `lanes link token show --raw${selection}`;
  const argv = ['link', 'token', 'show', '--raw', '--workspace', target];

  const resolved = Bun.which('lanes');
  if (resolved) {
    try {
      const result = Bun.spawnSync([resolved, ...argv]);
      // Exit status and a plausible token, rather than a comparison against a
      // known value. This used to be handed the expected token and check for
      // equality, which caught a `lanes` on PATH belonging to a different
      // workspace. It cannot now: with several rows issued, `token show`
      // refuses without `--id` — so demanding one value back would reject a
      // correctly-installed binary. What survives is the check that matters for
      // the failure this function exists to prevent, which is a substitution
      // that yields nothing at all.
      if (result.success && new TextDecoder().decode(result.stdout).trim().startsWith('llk_')) {
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

