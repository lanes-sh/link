import { MCP_PATH, serve } from './index.ts';
import { serveOverStdio } from './stdio.ts';
import { Generations, type OpenedWorkspace } from './generations.ts';
import type { AuthorizationSurface } from './oauth.ts';
import type { ProfileRuntime } from './mcp/index.ts';
import {
  AuthenticatorChain,
  IssuedTokenAuthenticator,
  OAuthServer,
  OAuthStore,
  OidcAuthenticator,
  OidcVerifier,
  tokensMatch,
  type Authenticator,
} from '#auth';
import type { Logger } from '#connectivity';
import { silentLogger } from './logging.ts';
import { listProfiles } from '#profile';
import {
  applyReconcile,
  formatPlan,
  planIsNoop,
  planReconcile,
  toPolicyDocument,
} from '#registry';
import { ensureProfileToken, openRuntime, type GlobalFlags, type Runtime } from '#cli/runtime.ts';

/**
 * Bringing the endpoint up: open a runtime per profile, reconcile, and serve.
 *
 * This is the bootstrap, and it exists as its own function because there are
 * now two callers with genuinely different needs. `lanes link start` runs it on
 * an operator's machine, prints to a terminal, and mints a profile token when
 * none exists. The container entrypoint runs it under Cloud Run, logs to
 * stdout, and must *not* mint anything — a token invented inside a container
 * that scales to zero is one nobody can read back, so the endpoint would come
 * up healthy and reject every agent.
 *
 * The alternative was for the image to shell out to `lanes link start`, which
 * would have made the container's behaviour a side effect of a CLI command's
 * presentation code. Everything below the reporter is identical on both paths,
 * which is what makes "the same config with only the target switched" true.
 */

export interface EndpointReporter {
  /** A profile whose runtime state differed from its config, and what was applied. */
  reconciled(input: { profile: string; plan: string; ofMany: boolean }): void;
  /** No profile token existed and one was minted. */
  tokenMinted(minted: { target: string }): void;
}

const SILENT: EndpointReporter = { reconciled() {}, tokenMinted() {} };

export interface EndpointOptions {
  readonly flags: GlobalFlags;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  /** Serve just the resolved profile, rather than every profile in the workspace. */
  readonly only?: boolean | undefined;
  /**
   * Mint a profile token when the store has none. True for `lanes link start`,
   * false in a container — see the note above.
   */
  readonly mintToken?: boolean | undefined;
  readonly reporter?: EndpointReporter | undefined;
  /** Operational events. Silent when absent, which is what the tests want. */
  readonly log?: Logger | undefined;
}

export interface RunningEndpoint {
  readonly url: string;
  readonly profiles: readonly string[];
  stop(): Promise<void>;
}

/**
 * Every profile this workspace serves, opened and reconciled.
 *
 * Shared by both transports because it is the whole of what "bring the
 * workspace up" means — which profiles, in what state. What differs after it is
 * only how they are reached: a port and a token, or a pipe.
 */
async function openReconciled(options: {
  readonly flags: GlobalFlags;
  readonly only?: boolean | undefined;
  readonly reporter?: EndpointReporter | undefined;
}): Promise<{ primary: Runtime; runtimes: Map<string, Runtime> }> {
  const reporter = options.reporter ?? SILENT;
  const primary = await openRuntime(options.flags);

  // One endpoint, every profile. The alternative — a port each — meant an agent
  // registering N servers to reach N profiles, and the ports leaked a detail
  // nobody wants to think about. What it costs is that a single token now
  // reaches every profile and the caller names which, so the boundary between
  // them is a policy decision per call rather than a separate URL.
  const names = options.only
    ? [primary.resolution.profile]
    : await listProfiles(primary.resolution.workspaceRoot);

  const runtimes = new Map<string, Runtime>();
  runtimes.set(primary.resolution.profile, primary);

  try {
    for (const name of names) {
      if (runtimes.has(name)) continue;
      runtimes.set(name, await openRuntime({ ...options.flags, profile: name }));
    }

    for (const [name, runtime] of runtimes) {
      const result = await planReconcile(
        runtime.config,
        runtime.state,
        runtime.credentials,
        runtime.manifestFor,
      );
      if (!planIsNoop(result)) {
        reporter.reconciled({
          profile: name,
          plan: formatPlan(result),
          ofMany: runtimes.size > 1,
        });
        await applyReconcile(runtime.config, runtime.state, result);
      }
    }

    return { primary, runtimes };
  } catch (error) {
    // A runtime opened before the failure holds a state handle, and in a
    // container a leaked pool keeps connections checked out of the pooler
    // while the process crash-loops.
    await closeAll(runtimes);
    throw error;
  }
}

/** What the transports need from a runtime, which is less than a runtime. */
function profileRuntimes(runtimes: ReadonlyMap<string, Runtime>): Map<string, ProfileRuntime> {
  return new Map(
    [...runtimes].map(([name, runtime]) => [
      name,
      {
        config: runtime.config,
        registry: runtime.registry,
        dispatcher: runtime.dispatcher,
        policy: toPolicyDocument(runtime.config),
        // So a skill written since this endpoint started — by an agent
        // through `skills.manage.write`, or by `lanes link skills add` in another
        // terminal — is a prompt without a restart (ADR-014).
        refreshSkills: runtime.refreshSkills,
      },
    ]),
  );
}

function closeAll(runtimes: ReadonlyMap<string, Runtime>): Promise<unknown> {
  return Promise.all([...runtimes.values()].map((runtime) => runtime.close()));
}

/**
 * The remote-client gate, if this profile declares one.
 *
 * Endpoint-scoped rather than per profile, like the bearer token and for the
 * same reason (ADR-009): one URL serves every profile in the workspace, so
 * there is one place a client authorises and one set of tokens.
 *
 * Returns null when `auth.authorization` is absent, and everything downstream
 * treats null as "exactly as before" — no metadata published, no pointer on the
 * `401`, one authenticator instead of a chain.
 */
async function openAuthorization(
  primary: Runtime,
): Promise<{ surface: AuthorizationSurface; authenticator: Authenticator } | null> {
  const declared = primary.config.auth.authorization;
  if (!declared) return null;

  const profile = primary.resolution.profile;

  if (declared.mode === 'oidc') {
    const audience = await primary.credentials.get(declared.client_id_ref);
    if (!audience) {
      // Refuse rather than verify without an audience. A verifier that cannot
      // check who a token was issued for accepts every token the issuer minted
      // for anything, which is the failure this mode exists to prevent.
      throw new Error(
        `auth.authorization.client_id_ref names "${declared.client_id_ref}", which is not in ` +
          `this target's credential store. Store it with: lanes link secrets set ${declared.client_id_ref}`,
      );
    }

    const verifier = new OidcVerifier({
      issuer: declared.issuer,
      audience,
      allowedSubjects: declared.allowed_subjects,
      ...(declared.introspection_endpoint
        ? { introspectionEndpoint: declared.introspection_endpoint }
        : {}),
    });

    return {
      // The issuer is somebody else's origin, so it is a constant here rather
      // than derived from the request.
      surface: { issuer: () => declared.issuer, mcpPath: MCP_PATH, target: primary.target },
      authenticator: new OidcAuthenticator(verifier, profile),
    };
  }

  const store = new OAuthStore(primary.state.kv);
  const expected = primary.config.auth.token_ref;

  const server = new OAuthServer({
    store,
    accessTokenTtlMs: declared.access_token_ttl_minutes * 60_000,
    // Approval is proof of holding the endpoint token, compared the same way
    // the request path compares it. There is one person behind this endpoint
    // and they already have exactly one credential; a second one invented for
    // the consent screen would be a password to lose.
    verifyOwner: async (presented) => {
      const token = await primary.credentials.get(expected);
      return token !== null && tokensMatch(presented, token);
    },
  });

  return {
    surface: { server, issuer: (origin) => origin, mcpPath: MCP_PATH, target: primary.target },
    authenticator: new IssuedTokenAuthenticator(store, profile),
  };
}

export async function startEndpoint(options: EndpointOptions): Promise<RunningEndpoint> {
  const reporter = options.reporter ?? SILENT;
  const { primary, runtimes } = await openReconciled(options);

  try {
    if (options.mintToken) {
      const { created } = await ensureProfileToken(
        primary.credentials,
        primary.config.auth.token_ref,
      );
      if (created) reporter.tokenMinted({ target: primary.target });
    } else {
      // Deployed, the token is written by the operator's CLI into the target's
      // credential store and read back here. Refusing to start beats serving an
      // endpoint whose token nobody holds.
      const token = await primary.credentials.get(primary.config.auth.token_ref);
      if (!token) {
        throw new Error(
          `No profile token at "${primary.config.auth.token_ref}" in this target's credential store. ` +
            'A deployed instance never mints its own — run `lanes link token rotate --target <target>` ' +
            'from your machine, or `lanes link secrets push --from local --to cloud`, then redeploy.',
        );
      }
    }

    const gate = await openAuthorization(primary);

    // The authenticator and the authorization gate are built once, from the
    // runtime this endpoint booted with, and are deliberately not part of what
    // a reload replaces (ADR-029). Retiring that generation stays safe for them
    // because `Runtime.close()` ends connector sessions and the audit log — it
    // does not close the credential store or the state handle these hold.
    const generations = new Generations(
      { profiles: profileRuntimes(runtimes), close: () => closeAll(runtimes).then(() => {}) },
      async (): Promise<OpenedWorkspace> => {
        const reopened = await openReconciled(options);
        return {
          profiles: profileRuntimes(reopened.runtimes),
          close: () => closeAll(reopened.runtimes).then(() => {}),
        };
      },
      { primary: primary.resolution.profile, log: { debug() {}, info() {}, warn() {}, error() {} } },
    );

    const server = serve({
      generations,
      primary: primary.resolution.profile,
      authenticator: gate
        ? new AuthenticatorChain([primary.authenticator, gate.authenticator])
        : primary.authenticator,
      log: options.log ?? silentLogger(),
      ...(gate ? { authorization: gate.surface } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
    });

    return {
      url: server.url,
      profiles: [...runtimes.keys()],
      // `server.stop()` closes the request handler, which closes whichever
      // generation is current — and a generation owns the runtimes it opened.
      // Closing `runtimes` here too would reach past a reload and close a set
      // nothing is serving from any more.
      stop: () => server.stop(),
    };
  } catch (error) {
    await closeAll(runtimes);
    throw error;
  }
}

export interface StdioEndpointOptions {
  readonly flags: GlobalFlags;
  /** Serve just the resolved profile, rather than every profile in the workspace. */
  readonly only?: boolean | undefined;
  /**
   * Where reconcile output goes.
   *
   * Not the terminal, on this path: stdout carries JSON-RPC, and a single line
   * written to it corrupts the stream for the client. The caller reports to
   * stderr or not at all.
   */
  readonly reporter?: EndpointReporter | undefined;
  readonly log?: Logger | undefined;
  readonly clientLabel?: string | undefined;
}

export interface RunningStdioEndpoint {
  readonly profiles: readonly string[];
  stop(): Promise<void>;
}

/**
 * The same workspace, served over this process's stdin and stdout.
 *
 * No port, no token, no reachability question — see `stdio.ts` for why the pipe
 * replaces the authenticator. Used by clients that cannot be handed a URL at
 * all, which is most desktop applications.
 */
export async function startStdioEndpoint(
  options: StdioEndpointOptions,
): Promise<RunningStdioEndpoint> {
  const { primary, runtimes } = await openReconciled(options);

  try {
    const surface = serveOverStdio({
      profiles: profileRuntimes(runtimes),
      primary: primary.resolution.profile,
      log: options.log ?? silentLogger(),
      ...(options.clientLabel ? { clientLabel: options.clientLabel } : {}),
    });

    return {
      profiles: [...runtimes.keys()],
      async stop() {
        await surface.close();
        await closeAll(runtimes);
      },
    };
  } catch (error) {
    await closeAll(runtimes);
    throw error;
  }
}
