import { MCP_PATH, serve, type RunningServer } from './index.ts';
import { serveOverStdio } from './stdio.ts';
import { Generations, type OpenedWorkspace } from './generations.ts';
import type { AuthorizationSurface } from './oauth.ts';
import type { ProfileRuntime } from './mcp/index.ts';
import { AuthenticatorChain } from '#auth';
import { openAuthorization } from './authorization.ts';
import { openReadListener } from './read/open.ts';
import { deployedReadDeps } from './read/deployed.ts';
import { version } from '#cli/version.ts';
import type { Logger } from '#connectivity';
import { silentLogger } from './logging.ts';
import { listProfiles, readConnections } from '#profile';
import {
  applyReconcile,
  formatPlan,
  planIsNoop,
  planReconcile,
  toPolicyDocument,
} from '#registry';
import { openRuntime, type GlobalFlags, type Runtime } from '#cli/runtime.ts';

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
  /**
   * A sibling profile that could not be opened against this target.
   *
   * Optional because it is new and every caller predates it, and because
   * silence is a defensible reading for a caller that only wants what it got.
   */
  skipped?(input: { profile: string; reason: string }): void;
}

const SILENT: EndpointReporter = { reconciled() {} };

/** The first line of an error, which is the part fit to print beside a name. */
function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}

export interface EndpointOptions {
  readonly flags: GlobalFlags;
  readonly port?: number | undefined;
  readonly host?: string | undefined;
  /** Serve just the resolved profile, rather than every profile in the workspace. */
  readonly only?: boolean | undefined;
  readonly reporter?: EndpointReporter | undefined;
  /** Operational events. Silent when absent, which is what the tests want. */
  readonly log?: Logger | undefined;
}

export interface RunningEndpoint {
  readonly url: string;
  readonly profiles: readonly string[];
  /** The dashboard read surface, when this workspace is paired (ADR-063). */
  readonly readUrl?: string | undefined;
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

      // A sibling that does not declare this target is skipped, not fatal.
      //
      // Every profile here is opened against the one target the endpoint was
      // started with, and a workspace may hold a profile that runs somewhere
      // else entirely. Refusing would let one such profile take the endpoint
      // down for all of them, which is the opposite of what `start` is for —
      // and in a container it is a revision that never goes healthy. Skipping
      // is not an assumption: it is reported, and `served` below is derived
      // from what actually opened rather than from what is on disk.
      try {
        runtimes.set(name, await openRuntime({ ...options.flags, profile: name }));
      } catch (error) {
        if (name === primary.resolution.profile) throw error;
        reporter.skipped?.({ profile: name, reason: message(error) });
      }
    }

    // Once for the workspace, over every connection the workspace holds.
    //
    // Runtime state is one store per workspace since contract 3, and reconcile
    // disables everything in it that the connection list does not declare — so
    // running it per profile over that profile's *grants* had each pass disable
    // the connections only the other profiles granted. Two profiles was enough:
    // the second pass disabled the first's accounts, every later call was
    // refused `denied_connection_unauthorized`, and restarting flipped which
    // profile survived.
    //
    // The primary's runtime is used for the stores because they are the same
    // stores for every profile here. `workspaceConnections` is the whole list,
    // which is what "undeclared" has to be measured against.
    const declared = primary.workspaceConnections;
    const result = await planReconcile(
      declared,
      primary.state,
      primary.credentials,
      primary.manifestFor,
    );
    if (!planIsNoop(result)) {
      reporter.reconciled({
        profile: primary.resolution.profile,
        plan: formatPlan(result),
        ofMany: false,
      });
      await applyReconcile(declared, primary.state, result);
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
        // For the `connection` argument's description: an id says nothing about
        // which account it is, and the caller choosing between two of a vendor
        // has only that description to go on.
        connections: runtime.connections,
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


export async function startEndpoint(options: EndpointOptions): Promise<RunningEndpoint> {
  const reporter = options.reporter ?? SILENT;
  const log = options.log ?? silentLogger();
  const { primary, runtimes } = await openReconciled(options);

  try {
    // **No token is minted or required here any more** (ADR-068). Both halves of
    // what used to be at this point are gone, and for the same reason.
    //
    // Minting: `start` did it because there was one token per endpoint and it
    // had to exist for anything to connect. A token names the person it was
    // issued to now, and `start` does not know who is about to connect — so
    // inventing one would be binding a credential to a subject nobody chose.
    //
    // Refusing: a deployed revision used to fail to boot without one, on the
    // reasoning that an endpoint whose token nobody holds is no use. Since
    // ADR-062 that is backwards. A client discovers the protected-resource
    // document, signs its owner in, and comes back with a token of its own; a
    // static row is what CI uses because it has no browser. Zero rows is the
    // ordinary state of a healthy endpoint, and refusing to serve was refusing
    // the case the endpoint is now built for.
    // Read through a holder rather than closed over `runtimes`, because a
    // reload replaces that map and the gate is deliberately built once
    // (ADR-029). Without the indirection, a member added after start would
    // stay invisible until the endpoint was restarted — which is precisely the
    // thing `profile members add` tells the operator has taken effect.
    let serving: ReadonlyMap<string, Runtime> = runtimes;

    const gate = await openAuthorization(primary, log, async (subject) =>
      [...serving]
        .filter(([, runtime]) =>
          runtime.config.members.some((member) => member.subject === subject),
        )
        .map(([name]) => name),
    );

    // The authenticator and the authorization gate are built once, from the
    // runtime this endpoint booted with, and are deliberately not part of what
    // a reload replaces (ADR-029). Retiring that generation stays safe for them
    // because `Runtime.close()` ends connector sessions and the audit log — it
    // does not close the credential store or the state handle these hold.
    const generations = new Generations(
      { profiles: profileRuntimes(runtimes), close: () => closeAll(runtimes).then(() => {}) },
      async (): Promise<OpenedWorkspace> => {
        const reopened = await openReconciled(options);
        serving = reopened.runtimes;
        return {
          profiles: profileRuntimes(reopened.runtimes),
          close: () => closeAll(reopened.runtimes).then(() => {}),
        };
      },
      // The same logger the request handler gets, rather than the inline no-op
      // this used to be. What a generation has to say is exactly what nobody
      // could see when a reload went wrong: `could not reload config`, `could
      // not refresh skills`, and every `mcp handler error` the endpoint raises
      // all went to those empty methods. A silent endpoint is not a quiet one —
      // it is one whose failures have to be reconstructed from request sizes.
      // `remoteClients` is the gate's existence, not a second setting: a profile
      // declaring `auth.authorization` is one a connector reaches by URL, which
      // is exactly the client the extra paragraph is written for.
      { primary: primary.resolution.profile, log, ...(gate ? { remoteClients: true } : {}) },
    );

    // Read once. `version()` walks up to the install root and parses
    // `package.json`; doing it per request would put a synchronous file read on
    // the read surface's hot path to answer a value that cannot change while
    // this process lives.
    const runningVersion = version();

    const server = serve({
      generations,
      primary: primary.resolution.profile,
      authenticator: gate
        ? new AuthenticatorChain([primary.authenticator, gate.authenticator])
        : primary.authenticator,
      log,
      ...(gate ? { authorization: gate.surface } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(options.host !== undefined ? { host: options.host } : {}),
      // Offered unconditionally and discarded by `serve()` on a loopback bind,
      // which is where every other property of the bind address is decided. It
      // opens nothing and reads no credential, so building it for a bind that
      // will not use it costs a closure (ADR-064).
      read: deployedReadDeps({
        primary,
        profiles: () => generations.current.profiles,
        log,
        version: runningVersion,
      }),
    });

    // After `serve()`, so the record means the socket is bound. Recording it
    // from the constructor claimed an endpoint that a failed bind never served.
    generations.announce();

    // Only when `lanes link pair` has provisioned all three. Absent, this is
    // simply not served — the read surface is opt-in and its absence is the
    // default (ADR-063), so an endpoint that was never paired binds one port
    // exactly as it always did.
    const read = await openReadListener(
      primary,
      server,
      () => generations.current.profiles,
      log,
      runningVersion,
    );

    return {
      url: server.url,
      profiles: [...runtimes.keys()],
      ...(read ? { readUrl: read.url } : {}),
      // `server.stop()` closes the request handler, which closes whichever
      // generation is current — and a generation owns the runtimes it opened.
      // Closing `runtimes` here too would reach past a reload and close a set
      // nothing is serving from any more.
      stop: async () => {
        await read?.stop();
        await server.stop();
      },
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
