import {
  soleGrantFor,
  ConfigError,
  KNOWLEDGE_LAYOUT,
  knowledgeTargetSchema,
  layout,
  parseRepository,
  type Config,
  type KnowledgeConfig,
} from '#profile';
import { describeKnowledge, type FetchLike } from '#deployments/knowledge.ts';
import { ConfigDocument } from '../../config-edit.ts';
import { announce, heading, ok, print, style, table } from '../../output.ts';
import { confirm, isInteractive } from '../../prompt.ts';
import type { BlobStore } from '#stores/blobs';
import { openRuntime, openSecretStoreFor, type GlobalFlags, type Runtime } from '../../runtime.ts';
import { probe, repositoryFor, resolveToken } from './setup.ts';
import {
  collisions,
  localContents,
  moveIn,
  moveOut,
  printMovable,
  removeLocal,
  summarise,
} from './migrate.ts';
/**
 * `lanes link knowledge` — where this profile's memory and skills are kept.
 *
 * Control plane, like every other command here: it writes a credential and
 * edits config, both of which authorise future agent behaviour, so it
 * originates outside the agent and has no MCP surface (ADR-007).
 *
 * The block it writes goes into **every** target the profile declares. A
 * profile's memory is one thing wherever the profile happens to be running, and
 * a `local` that reads a repository beside a `cloud` that reads a disk is two
 * divergent sets of entries with nothing saying which is current. Each target
 * still needs the token in its *own* credential store, which is what
 * `lanes link secrets push` is for, and the command says so.
 *
 * ADR-041.
 */

export interface KnowledgeFlags extends GlobalFlags {
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly path?: string | undefined;
  /**
   * Move what is already stored, rather than leaving it behind.
   *
   * Three states, not two. `undefined` means nobody said, which is a question
   * worth asking rather than an answer worth guessing — so `--migrate` and
   * `--no-migrate` are both flags, and a run with neither and nothing to move
   * proceeds silently.
   */
  readonly migrate?: boolean | undefined;
  /** Copy rather than move: verify the repository, then leave the local copy. */
  readonly keep?: boolean | undefined;
  readonly allowPublic?: boolean | undefined;
  /** Ask for the token again even though one is stored. */
  readonly replace?: boolean | undefined;
  readonly yes?: boolean | undefined;
  readonly json?: boolean | undefined;
  /** Injected for tests. The repository is the only thing this command reaches. */
  readonly fetch?: FetchLike | undefined;
}

export async function knowledgeUse(where: string | undefined, flags: KnowledgeFlags): Promise<void> {
  if (where === 'local') return useLocal(flags);
  if (where === 'github') return useGithub(flags);

  throw new ConfigError(
    'Usage: lanes link knowledge use github --repo <owner/name> [--branch b] [--path p] [--migrate]\n' +
      '       lanes link knowledge use local [--migrate]',
  );
}

async function useGithub(flags: KnowledgeFlags): Promise<void> {
  if (!flags.repo) {
    throw new ConfigError(
      'Which repository? lanes link knowledge use github --repo <owner/name>\n' +
        '  Make it private — memory entries are your own notes, and a skill names the accounts it operates on.',
    );
  }

  const repo = parseRepository(flags.repo);
  if (!repo) {
    throw new ConfigError(
      `"${flags.repo}" is not a repository. Give it as owner/name, or paste the URL of one.`,
    );
  }

  const knowledge = knowledgeTargetSchema.parse({
    adapter: 'github',
    repo,
    ...(flags.branch ? { branch: flags.branch } : {}),
    ...(flags.path ? { path: flags.path } : {}),
  });

  const runtime = await openRuntime(flags, { fetch: flags.fetch });
  try {
    announce(runtime.resolution);
    const selection = ` --profile ${runtime.resolution.profile} --workspace ${runtime.target}`;

    if (runtime.knowledge) {
      print(style.dim(`  This profile already reads ${runtime.knowledge.describe}.`));
      print(
        style.dim(
          '  Bring it back first: lanes link knowledge use local --migrate' +
            ` --profile ${runtime.resolution.profile} --target ${runtime.target}`,
        ),
      );
      throw new ConfigError('Already storing knowledge in a repository.');
    }

    // Nothing is written until this returns: the token is asked for, the
    // repository is probed, and either can refuse while the profile is intact.
    const secrets = await openSecretStoreFor(runtime.resolution.workspaceRoot, runtime.target);
    const token = await resolveToken(secrets, knowledge.token_ref, knowledge.repo, selection, {
      replace: flags.replace,
    });

    const repository = repositoryFor(knowledge, token, flags.fetch);
    const { facts, viewer } = await probe(repository, { allowPublic: flags.allowPublic });

    heading(describeKnowledge(knowledge));
    table([
      ['  repository', facts.fullName, style.dim(facts.private ? 'private' : style.yellow('public'))],
      ['  branch', knowledge.branch ?? facts.defaultBranch, style.dim(facts.empty ? 'no commits yet' : '')],
      ['  token', viewer, style.dim('can write')],
    ]);

    // Which instances this profile grants, so `memory/` and `entities/` reach
    // only its own and not every profile's (ADR-059).
    const instances = grantedInstances(runtime.config);

    const movable = await localContents(
      runtime.storage,
      runtime.skills ?? null,
      knowledge,
      instances,
    );
    const moving = await decideMigration(movable.length > 0, flags);

    if (moving) {
      const overlap = await collisions(repository, movable);
      if (overlap.length > 0 && !(await agreedTo(flags, `${overlap.length} file(s) already in ${facts.fullName} would be replaced. Continue?`))) {
        return;
      }

      print('');
      print(`  Moving ${summarise(movable)} into ${facts.fullName}:`);
      printMovable(movable);

      await moveIn(repository, movable, `Store this profile's memory and skills`);
      print(ok(`committed ${movable.length} file${movable.length === 1 ? '' : 's'}, and read them back`));

      if (flags.keep) {
        print(style.dim('  --keep: the local copies are still there, and are no longer read.'));
      } else {
        await removeLocal(runtime.storage, runtime.skills ?? null, movable, instances);
        print(ok('removed the local copies'));
      }
    } else if (movable.length > 0) {
      print('');
      print(
        style.dim(
          `  ${summarise(movable)} stay on disk and stop being read. Move them with --migrate.`,
        ),
      );
    }

    // Last, deliberately, and in this order. Everything above can fail and leave
    // a profile that still works; from here the config points at the repository.
    // The token goes in first because the failure directions are not symmetric:
    // a stored token nothing references is inert, and a config referencing a
    // token that was never stored is a profile that cannot read its own memory.
    await secrets.set(knowledge.token_ref, token);
    await writeBlock(runtime.config, runtime.resolution.workspaceRoot, knowledge);

    print('');
    print(ok(`memory and skills are now kept in ${facts.fullName}`));
  } finally {
    await runtime.close();
  }
}

async function useLocal(flags: KnowledgeFlags): Promise<void> {
  const runtime = await openRuntime(flags, { fetch: flags.fetch });
  try {
    announce(runtime.resolution);
    const selection = ` --profile ${runtime.resolution.profile} --target ${runtime.target}`;

    const knowledge = runtime.config.knowledge;
    if (!knowledge) {
      print(style.dim('  This profile already keeps memory and skills on its own storage.'));
      return;
    }

    const local = await openLocalStores(runtime);

    // Built here rather than taken from `runtime.knowledge`, so both directions
    // of this command reach the repository through one constructor.
    const secrets = await openSecretStoreFor(runtime.resolution.workspaceRoot, runtime.target);
    const token = await resolveToken(secrets, knowledge.token_ref, knowledge.repo, selection);
    const repository = repositoryFor(knowledge, token, flags.fetch);

    if (
      flags.migrate ??
      (await agreedTo(flags, `Copy everything in ${knowledge.repo} back onto this target's storage?`))
    ) {
      const moved = await moveOut(
        repository,
        knowledge,
        local.storage,
        local.skills,
        grantedInstances(runtime.config),
      );
      print(
        ok(
          `wrote back ${moved.memory} memory entr${moved.memory === 1 ? 'y' : 'ies'}, ` +
            `${moved.skills} skill file${moved.skills === 1 ? '' : 's'} and ` +
            `${moved.entities} entity file${moved.entities === 1 ? '' : 's'}`,
        ),
      );
    }

    await writeBlock(runtime.config, runtime.resolution.workspaceRoot, undefined);

    print('');
    print(ok('memory, skills and entities are back on this target\'s own storage'));
    print(
      style.dim(
        `  ${knowledge.repo} still holds everything — it is version control, so nothing was removed from it.`,
      ),
    );
    print(style.dim(`  The token at "${knowledge.token_ref}" is no longer used; remove it if you like.`));
  } finally {
    await runtime.close();
  }
}

/**
 * The profile's own stores, opened past whatever routing the runtime applied.
 *
 * `runtime.storage` and `runtime.skills` point at the repository once the block
 * is declared, which is exactly wrong for a command whose job is to write the
 * other way. This reaches the target's declared storage directly.
 */
async function openLocalStores(
  runtime: Runtime,
): Promise<{ storage: BlobStore; skills: BlobStore | null }> {
  const { openStorage } = await import('#deployments/target.ts');
  const declared = runtime.declared;

  const factory = await openStorage(
    {
      declared,
      config: runtime.config,
      root: runtime.resolution.workspaceRoot,
      target: runtime.target,
    },
    runtime.credentials,
  );
  // The *granted* connection, beside the profile. `layout.skills` changed
  // meaning without changing arity at ADR-059, so the compiler was silent;
  // ADR-066 put the profile back in front of it, and it is an argument now.
  const skillsConnection = soleGrantFor(runtime.config, 'skills');
  return {
    storage: factory(),
    skills: skillsConnection === undefined ? null : factory(layout.skills(runtime.config.instance.profile, skillsConnection)),
  };
}

/**
 * Write, or remove, this profile's knowledge block.
 *
 * One place, not one per target. It used to loop over every target the profile
 * declared and write the same block into each — which is what a per-target key
 * holding a per-profile fact costs. The block is on the profile now (ADR-052),
 * so there is one of it.
 */
async function writeBlock(
  config: Config,
  root: string,
  knowledge: KnowledgeConfig | undefined,
): Promise<void> {
  const document = await ConfigDocument.open(root, config.instance.profile);

  if (knowledge === undefined) {
    document.removeIn(['knowledge']);
  } else {
    document.setIn(['knowledge'], {
      adapter: knowledge.adapter,
      repo: knowledge.repo,
      ...(knowledge.branch ? { branch: knowledge.branch } : {}),
      ...(knowledge.path ? { path: knowledge.path } : {}),
      token_ref: knowledge.token_ref,
    });
  }

  await document.save();
}

async function decideMigration(hasContent: boolean, flags: KnowledgeFlags): Promise<boolean> {
  if (flags.migrate !== undefined) return flags.migrate;
  if (!hasContent) return false;
  return agreedTo(flags, 'Move what is already stored into the repository?');
}

/**
 * Ask, unless `--yes` already answered or there is nobody to ask.
 *
 * Refuses rather than assuming when there is no terminal: every question here
 * precedes something that writes, and guessing at one of them is how a
 * scripted run migrates a profile nobody asked it to.
 */
async function agreedTo(flags: KnowledgeFlags, question: string): Promise<boolean> {
  if (flags.yes) return true;
  if (!isInteractive()) {
    throw new ConfigError(
      `${question} — stdin is not a terminal, so there is nobody to ask.\n` +
        '  Pass --migrate to move what is stored, --no-migrate to leave it, or --yes to accept every question.',
    );
  }

  const yes = await confirm(question, true);
  if (!yes) print(style.dim('  cancelled'));
  return yes;
}

/**
 * The memory and entities instances one profile grants.
 *
 * `main` where a profile grants none, which is what a profile that predates the
 * owner layer looks like and is also where a fresh one puts them. The point is
 * that this is never the *surface* — `memory/` alone matches every profile's
 * notes now that the blob root is the workspace's.
 */
function grantedInstances(config: Parameters<typeof soleGrantFor>[0]): {
  memory: string;
  entities: string;
} {
  return {
    memory: soleGrantFor(config, 'memory') ?? 'main',
    entities: soleGrantFor(config, 'entities') ?? 'main',
  };
}
