import { memberPrincipal, ownerPrincipal, type Principal } from '#auth';
import type { Logger } from '#connectivity';
import { MANAGED_TARGET, listProfiles, loadWorkspaceProfiles } from '#profile';
import { openRuntime } from '#cli/runtime.ts';
import { profileRuntimes } from './endpoint.ts';
import { Generations, type OpenedWorkspace } from './generations.ts';
import type { Generation } from './generation.ts';

/**
 * The data plane: a hosted workspace's own MCP surface, reached through the API.
 *
 * **Why this exists at all.** A managed workspace has been configurable and
 * unreadable since it shipped. Profiles, grants and members all worked, and an
 * agent could not reach a single thing behind them, because the only MCP
 * surface a hosted workspace had was one nobody could connect to: the runtime
 * is `--no-allow-unauthenticated` (ADR-074) and has no URL a client could be
 * pointed at. The Data and Audit tabs said "not reachable from here yet" and
 * they were right.
 *
 * **It is a proxy, not a second protocol.** `generation.handlerFor(principal)`
 * already is the whole MCP surface for one caller, and it is what the local and
 * self-hosted endpoints serve. So the API forwards JSON-RPC here rather than
 * this inventing a `tools/list`-shaped API of its own — which would have been a
 * second wire format to keep in step with the first, and the first is a
 * published spec.
 *
 * **The caller is the assertion's subject, and the profiles are read live.**
 * Exactly as the endpoint's own bearer path does: the subject comes from a
 * credential, the member list comes from the workspace, and removing somebody
 * from a profile ends their reach without anything being revoked. The API
 * cannot pass a profile list — an agent that could name its own reach would be
 * deciding what it may see.
 *
 * **In `server` rather than `control`, and the dependency test decided it.**
 * This holds `Generations`, which is `server`'s, and `control` may not reach
 * `server` — the two answer different questions with different credentials and
 * the arrow between them points one way (`src/architecture.test.ts`).
 */

/** Held open per workspace, so a second call does not re-read the whole store. */
interface Resident {
  readonly generations: Generations;
  /** Requests inside it. A resident is only closed at zero. */
  inFlight: number;
  touched: number;
}

export interface DataDeps {
  readonly log: Logger;
  /** How many workspaces stay resident. Beyond it, the least recently used goes. */
  readonly limit?: number;
}

/**
 * Open every profile in a workspace, against the managed target.
 *
 * A workspace with no profiles opens to nothing rather than failing, which is
 * the state a freshly provisioned one is in — and the reason `container.ts`
 * could not serve it. There is nothing to advertise yet and that is a valid
 * answer, not an error.
 */
async function openWorkspace(
  env: Record<string, string | undefined>,
  log: Logger,
): Promise<OpenedWorkspace> {
  const root = env['LANES_LINK_HOME'] ?? '';
  const names = await listProfiles(root);
  const profiles = new Map<string, Awaited<ReturnType<typeof openRuntime>>>();

  for (const profile of names) {
    try {
      const runtime = await openRuntime({ profile, target: MANAGED_TARGET, quiet: true }, { env });
      profiles.set(profile, runtime);
    } catch (error) {
      // One unreadable profile must not take the workspace down for the rest,
      // which is the same rule `openReconciled` applies to a sibling that does
      // not declare this target. A profile mid-write is a common cause and it
      // repairs itself on the next read.
      log.warn('could not open a profile', {
        profile,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    // Through the endpoint's own mapping rather than a second copy of it: a
    // `ProfileRuntime` is less than a `Runtime` and the difference includes
    // `policy`, which is not the thing to reconstruct by hand.
    profiles: profileRuntimes(profiles),
    async close() {
      await Promise.all([...profiles.values()].map((runtime) => runtime.close()));
    },
  };
}

/**
 * The workspaces this process is holding open, and the MCP handler for a caller.
 *
 * An LRU with the same drain-before-close discipline as `createWorkspaceRouter`:
 * a resident evicted while a request is inside it is retired rather than closed,
 * because closing a store underneath an in-flight dispatch is a failure with no
 * useful message.
 */
export function createDataPlane(deps: DataDeps) {
  const limit = deps.limit ?? 32;
  const residents = new Map<string, Resident>();

  const evict = async (): Promise<void> => {
    while (residents.size > limit) {
      const oldest = [...residents.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
      if (!oldest) return;
      const [key, resident] = oldest;
      residents.delete(key);
      if (resident.inFlight === 0) {
        try {
          await resident.generations.close();
        } catch (error) {
          deps.log.warn('could not close a workspace', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  };

  const acquire = async (
    workspace: string,
    env: Record<string, string | undefined>,
  ): Promise<Resident> => {
    const existing = residents.get(workspace);
    if (existing) {
      existing.touched = Date.now();
      existing.inFlight += 1;
      return existing;
    }

    const opened = await openWorkspace(env, deps.log);
    // `primary` decides which profile a refusal is recorded against and which
    // principal the owner-visible set is computed for. The first profile is an
    // arbitrary but stable choice; every caller here is a member, so what they
    // actually see is decided by their own principal below rather than by this.
    const primary = [...opened.profiles.keys()][0] ?? '';
    const generations = new Generations(opened, () => openWorkspace(env, deps.log), {
      primary,
      log: deps.log,
    });

    const resident: Resident = { generations, inFlight: 1, touched: Date.now() };
    residents.set(workspace, resident);
    await evict();
    return resident;
  };

  const release = async (workspace: string, resident: Resident): Promise<void> => {
    resident.inFlight -= 1;
    if (resident.inFlight === 0 && residents.get(workspace) !== resident) {
      await resident.generations.close();
    }
  };

  return {
    /**
     * Serve one MCP request for one subject against one workspace.
     *
     * Returns null when the workspace has no profile this subject is a member
     * of — which is a real and ordinary state (somebody in the Lanes workspace
     * who has not been added to a Link profile) and is answered as an empty
     * surface rather than as a refusal. The caller decides how to say so.
     */
    async serve(input: {
      readonly workspace: string;
      readonly subject: string;
      readonly env: Record<string, string | undefined>;
      readonly request: Request;
      readonly clientLabel?: string | undefined;
    }): Promise<Response | null> {
      const resident = await acquire(input.workspace, input.env);

      try {
        const generation: Generation = resident.generations.acquire();
        try {
          // Read from the workspace on every call rather than carried in from
          // the API. The whole point of resolving membership live is that
          // removing somebody ends their reach immediately, and a list that
          // travelled with the request would be as stale as whoever sent it.
          const { loaded } = await loadWorkspaceProfiles(input.env['LANES_LINK_HOME'] ?? '');
          const reachable = loaded
            .filter((one) => one.config.members.some((member) => member.subject === input.subject))
            .map((one) => one.profile);

          if (reachable.length === 0) return null;

          const principal: Principal =
            // The owner principal exists for a workspace being served to its own
            // operator over a pipe. Nobody here is that: every caller arrived
            // through the API as a named subject, so they get a member's
            // principal and `mayReach` does the rest.
            memberPrincipal(input.subject, reachable[0]!, reachable);

          await generation.refreshSkills();
          return await generation.handlerFor(principal, input.clientLabel).fetch(input.request);
        } finally {
          await resident.generations.release(generation);
        }
      } finally {
        await release(input.workspace, resident);
      }
    },

    async close(): Promise<void> {
      const open = [...residents.values()];
      residents.clear();
      await Promise.all(open.map((resident) => resident.generations.close()));
    },
  };
}

/** Exported for the test that pins who a hosted caller is served as. */
export { ownerPrincipal };
