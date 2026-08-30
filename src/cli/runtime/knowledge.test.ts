import { describe, expect, test } from 'bun:test';
import { KNOWLEDGE_LAYOUT, knowledgeRoot, parseRepository, knowledgeTargetSchema } from '#profile';
import { knowledgeStores } from '#deployments/knowledge.ts';
import { GithubRepository } from '#deployments/adapters/github-repo.ts';
import { createFakeGithub } from '#deployments/adapters/github-testing.ts';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import { routeBlobStore } from '#stores/blobs/route.ts';
import { scopeBlobStore } from '#stores/blobs';
import { scopeNamespace } from '#dispatch';
import { memoryStorage } from '#providers/owner.ts';
import { loadProfileSkills, writeSkill } from '#providers/skills/store.ts';

/**
 * That a profile pointed at a repository reaches the repository — through the
 * same two functions everything else uses, and without any of them knowing.
 *
 * The claim `openRuntime` makes is that redirecting the profile's blob root is
 * enough: `buildProviderContext` scopes it to `memory/<connection>`, and
 * `lanes link memory` scopes it identically, so neither has to be told. These
 * tests compose exactly what `openRuntime` composes and check that both
 * spellings land on the same object in the repository — which is the thing that
 * would silently be false if the routing prefix and the repository's directory
 * ever drifted apart.
 *
 * They stop short of `openRuntime` itself, which builds its own
 * `GithubRepository` against the real network. What that would add over this is
 * the credential lookup, which `target.ts` already covers.
 */

const knowledge = (overrides: Record<string, unknown> = {}) =>
  knowledgeTargetSchema.parse({ adapter: 'github', repo: 'my-org/my-notes', ...overrides });

async function open(overrides: Record<string, unknown> = {}) {
  const github = createFakeGithub();
  const config = knowledge(overrides);
  const repository = new GithubRepository({
    repo: config.repo,
    token: 'github_pat_stub',
    fetch: github.fetch,
    freshnessMs: 0,
  });
  const stores = await knowledgeStores(repository, config);

  // Exactly what `openRuntime` builds: the profile's blob root with `memory/`
  // and `entities/` routed away, and skills taken from the repository rather
  // than the profile.
  const storage = routeBlobStore(createMemoryBlobStore(), [
    { prefix: `${KNOWLEDGE_LAYOUT.memory}/`, store: stores.memory },
    { prefix: `${KNOWLEDGE_LAYOUT.entities}/`, store: stores.entities },
  ]);

  return { github, storage, skills: stores.skills };
}

describe('a profile whose knowledge is in a repository', () => {
  test('a memory entry written through the provider lands in the repository', async () => {
    const { github, storage } = await open();

    // `scopeNamespace` and `scopeBlobStore` are what `buildProviderContext`
    // calls — the provider itself never learns where it is rooted.
    const provider = scopeBlobStore(storage, scopeNamespace('memory', 'main'));
    await provider.put(memoryStorage.key('a-note'), new TextEncoder().encode('body'), {
      contentType: 'text/markdown',
    });

    expect(Object.keys(github.files())).toEqual(['memory/main/a-note.md']);
  });

  test('an entity and its derived index both land in the repository', async () => {
    const { github, storage } = await open();

    const provider = scopeBlobStore(storage, scopeNamespace('entities', 'main'));
    await provider.put(
      'jan-bakker.md',
      new TextEncoder().encode('---\nname: Jan Bakker\n---\n\n'),
      { contentType: 'text/markdown' },
    );
    await provider.put('_index.json', new TextEncoder().encode('{"v":1}'), {
      contentType: 'application/json',
    });

    // The index travels with the documents because it is derived from what
    // travels — the weaker half of ADR-055's argument, and worth pinning so it
    // is a decision rather than an accident.
    expect(Object.keys(github.files()).sort()).toEqual([
      'entities/main/_index.json',
      'entities/main/jan-bakker.md',
    ]);
  });

  test('the CLI and the provider address the same object', async () => {
    const { storage } = await open();

    const provider = scopeBlobStore(storage, scopeNamespace('memory', 'main'));
    await provider.put(memoryStorage.key('shared'), new TextEncoder().encode('written by the provider'));

    // `lanes link memory` builds its store from the same two functions, which
    // is the point of `memoryStore` in `commands/owner/memory.ts`.
    const cli = scopeBlobStore(storage, scopeNamespace('memory', 'main'));
    expect(new TextDecoder().decode((await cli.get('shared.md'))!)).toBe('written by the provider');
  });

  test('two connections of memory stay separate inside one repository', async () => {
    const { github, storage } = await open();

    for (const connection of ['main', 'work']) {
      const store = scopeBlobStore(storage, scopeNamespace('memory', connection));
      await store.put('note.md', new TextEncoder().encode(connection));
    }

    expect(github.files()).toEqual({
      'memory/main/note.md': 'main',
      'memory/work/note.md': 'work',
    });
  });

  test('skills round-trip through the store the registry is handed', async () => {
    const { github, skills } = await open();

    await writeSkill(skills, 'triage', '---\ndescription: Triage an inbox\n---\nSteps go here.\n');

    expect(Object.keys(github.files())).toEqual(['skills/triage/SKILL.md']);
    expect((await loadProfileSkills(skills)).map((loaded) => loaded.name)).toEqual(['triage']);
  });

  test('a path prefix moves both areas and keeps them apart', async () => {
    const { github, storage, skills } = await open({ path: 'context' });

    await scopeBlobStore(storage, scopeNamespace('memory', 'main')).put(
      'note.md',
      new TextEncoder().encode('m'),
    );
    await writeSkill(skills, 'triage', '---\ndescription: Triage\n---\nBody.\n');

    expect(Object.keys(github.files()).sort()).toEqual([
      'context/memory/main/note.md',
      'context/skills/triage/SKILL.md',
    ]);
  });

  test('everything that is not memory stays on the profile\'s own storage', async () => {
    const { github, storage } = await open();

    await storage.put('state.kv/connections.v1/example.a', new TextEncoder().encode('{}'));
    await storage.put('audit.log/run-1/0001.json', new TextEncoder().encode('{}'));

    expect(github.files()).toEqual({});
  });
});

describe('reading what somebody typed', () => {
  test.each([
    ['my-org/my-notes', 'my-org/my-notes'],
    ['https://github.com/my-org/my-notes', 'my-org/my-notes'],
    ['https://github.com/my-org/my-notes.git', 'my-org/my-notes'],
    ['https://www.github.com/my-org/my-notes/', 'my-org/my-notes'],
    ['  my-org/my-notes  ', 'my-org/my-notes'],
  ])('%s reduces to %s', (given, expected) => {
    expect(parseRepository(given)).toBe(expected);
  });

  test.each(['my-org', 'my-org/my-notes/extra', '/my-notes', 'https://example.test/a/b'])(
    '%s is not a repository',
    (given) => {
      expect(parseRepository(given)).toBeNull();
    },
  );
});

describe('the repository layout', () => {
  test('is three directories, and a prefix moves all of them', () => {
    expect(knowledgeRoot(knowledge(), 'memory')).toBe('memory');
    expect(knowledgeRoot(knowledge(), 'skills')).toBe('skills');
    expect(knowledgeRoot(knowledge(), 'entities')).toBe('entities');
    expect(knowledgeRoot(knowledge({ path: 'context' }), 'memory')).toBe('context/memory');
    expect(knowledgeRoot(knowledge({ path: 'context' }), 'entities')).toBe('context/entities');
  });

  test('a directory name is the provider namespace that routes into it', () => {
    // If these ever differ, a write goes to one place and a read looks in
    // another, and nothing fails — the entry is simply not there.
    expect(KNOWLEDGE_LAYOUT.memory).toBe('memory');
    expect(scopeNamespace('memory', 'main').startsWith(`${KNOWLEDGE_LAYOUT.memory}/`)).toBe(true);
    expect(KNOWLEDGE_LAYOUT.entities).toBe('entities');
    expect(scopeNamespace('entities', 'main').startsWith(`${KNOWLEDGE_LAYOUT.entities}/`)).toBe(
      true,
    );
  });

  test('what may move is still what a document is, and nothing else', () => {
    // ADR-041's exclusion is structural — there is no field that could name the
    // credential store or the vault — and ADR-055 adds none. Asserted here
    // because "and nothing else may" is the sentence a third area looks like it
    // weakened, and the thing that makes it still true is the absence of a key.
    expect(Object.keys(KNOWLEDGE_LAYOUT).sort()).toEqual(['entities', 'memory', 'skills']);
    expect(Object.keys(knowledgeTargetSchema.shape).sort()).toEqual([
      'adapter',
      'branch',
      'path',
      'repo',
      'token_ref',
    ]);
  });
});
