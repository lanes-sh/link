import { describe, expect, test } from 'bun:test';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { BlobStore } from '#stores/blobs';
import {
  loadWorkspaceSkills,
  parseSkill,
  readSkill,
  removeSkill,
  renderSkill,
  writeSkill,
} from './store.ts';

/**
 * A skill enters the system through this loader and leaves through `writeSkill`,
 * so what either accepts is a security boundary as much as a parsing
 * convenience — the name becomes a capability id, and the body becomes
 * instructions an agent receives as its own turn.
 *
 * The store is a `BlobStore` rather than a directory (ADR-014): locally it is
 * still `<workspace>/skills/`, holding the same files, but a deployed instance
 * has no writable directory that survives a revision and does have a bucket.
 */

async function skillsIn(files: Record<string, string> = {}): Promise<BlobStore> {
  const store = createMemoryBlobStore();
  for (const [key, contents] of Object.entries(files)) {
    await store.put(key, new TextEncoder().encode(contents));
  }
  return store;
}

const MINIMAL = `---
name: review-diff
description: Review a diff for correctness
---
Review the following diff.`;

describe('finding skills in the store', () => {
  test('an empty store is the normal case, not an error', async () => {
    expect(await loadWorkspaceSkills(await skillsIn())).toEqual([]);
  });

  test('reads both layouts: a flat file and a SKILL.md in a directory', async () => {
    const store = await skillsIn({
      'flat.md': `---\ndescription: A flat one\n---\nBody`,
      'nested/SKILL.md': `---\ndescription: A nested one\n---\nBody`,
    });

    expect((await loadWorkspaceSkills(store)).map((skill) => skill.name).sort()).toEqual([
      'flat',
      'nested',
    ]);
  });

  test('the name falls back to the filename', async () => {
    const store = await skillsIn({ 'draft-reply.md': `---\ndescription: d\n---\nBody` });
    expect((await loadWorkspaceSkills(store))[0]?.name).toBe('draft-reply');
  });

  test('a directory without a SKILL.md is skipped rather than failing the load', async () => {
    // A skill directory legitimately holds references and scripts beside its
    // SKILL.md, and one unparseable neighbour must not hide every other skill.
    const store = await skillsIn({
      'notes/README.md': 'not a skill',
      'real.md': `---\ndescription: d\n---\nBody`,
    });

    expect((await loadWorkspaceSkills(store)).map((skill) => skill.name)).toEqual(['real']);
  });
});

describe('writing a skill — ADR-014', () => {
  test('a written skill is loadable, and readable by name', async () => {
    const store = await skillsIn();
    await writeSkill(store, 'review-diff', MINIMAL);

    expect((await loadWorkspaceSkills(store)).map((skill) => skill.name)).toEqual(['review-diff']);
    expect((await readSkill(store, 'review-diff'))?.description).toBe(
      'Review a diff for correctness',
    );
  });

  test('a malformed skill is refused before it is stored, not after', async () => {
    // A skill that fails to load is invisible until the next start, by which
    // point the reason is a long way from the write that caused it.
    const store = await skillsIn();

    await expect(writeSkill(store, 'broken', 'no frontmatter here')).rejects.toThrow(/frontmatter/);
    expect(await loadWorkspaceSkills(store)).toEqual([]);
  });

  test('rewriting a nested skill stays nested, rather than forking into two files', async () => {
    // Two files claiming one capability id is a provider the registry refuses
    // to build at all.
    const store = await skillsIn({ 'nested/SKILL.md': `---\ndescription: first\n---\nBody` });

    await writeSkill(store, 'nested', `---\ndescription: second\n---\nBody`);

    expect((await store.list()).map((blob) => blob.key)).toEqual(['nested/SKILL.md']);
    expect((await readSkill(store, 'nested'))?.description).toBe('second');
  });

  test('frontmatter that renames the skill is refused rather than silently obeyed', async () => {
    const store = await skillsIn();

    await expect(
      writeSkill(store, 'review-diff', `---\nname: other\ndescription: d\n---\nBody`),
    ).rejects.toThrow(/names this skill "other"/);
  });

  test('a name policy could not express is refused before anything is read', async () => {
    const store = await skillsIn();
    await expect(writeSkill(store, 'Review Diff', MINIMAL)).rejects.toThrow(/must be lowercase/);
  });

  test('removing takes whichever layout holds it, and says when there was none', async () => {
    const store = await skillsIn({ 'nested/SKILL.md': `---\ndescription: d\n---\nBody` });

    expect(await removeSkill(store, 'nested')).toBe(true);
    expect(await removeSkill(store, 'nested')).toBe(false);
    expect(await loadWorkspaceSkills(store)).toEqual([]);
  });

  test('reading one that is not there is null, not a throw', async () => {
    expect(await readSkill(await skillsIn(), 'absent')).toBeNull();
  });
});

describe('what a skill file must contain', () => {
  test('frontmatter, a description, and a body', () => {
    const skill = parseSkill(MINIMAL, 'review-diff.md', 'fallback');

    expect(skill.name).toBe('review-diff');
    expect(skill.description).toBe('Review a diff for correctness');
    expect(skill.body.trim()).toBe('Review the following diff.');
    expect(skill.arguments).toEqual([]);
  });

  test('a missing description is refused — it is all an agent sees', () => {
    expect(() => parseSkill(`---\nname: x\n---\nBody`, 'x.md', 'x')).toThrow(/description/);
  });

  test('an empty body is refused — there is no procedure to render', () => {
    expect(() => parseSkill(`---\ndescription: d\n---\n\n`, 'x.md', 'x')).toThrow(/no body/);
  });

  test('missing frontmatter is refused', () => {
    expect(() => parseSkill(`Just a body`, 'x.md', 'x')).toThrow(/frontmatter/);
  });

  test('a name policy could not express is refused rather than slugified', () => {
    // The name becomes `skills.<name>`, which policy rules and MCP wire names
    // both constrain. Renaming it silently would mean a rule that quietly stops
    // matching.
    expect(() => parseSkill(`---\nname: Review Diff\ndescription: d\n---\nB`, 'x.md', 'x')).toThrow(
      /must be lowercase/,
    );
  });

  test('arguments are parsed with their required flag', () => {
    const skill = parseSkill(
      `---\ndescription: d\narguments:\n  - name: diff\n    description: The diff\n    required: true\n  - name: style\n---\nBody`,
      'x.md',
      'x',
    );

    expect(skill.arguments).toEqual([
      { name: 'diff', description: 'The diff', required: true },
      { name: 'style', description: 'style' },
    ]);
  });
});

describe('rendering a skill body', () => {
  test('substitutes named placeholders', () => {
    expect(renderSkill('Review {{diff}} in {{style}} style', { diff: 'D', style: 'terse' })).toBe(
      'Review D in terse style',
    );
  });

  test('an omitted argument leaves its placeholder visible', () => {
    // "Review the diff below" with nothing below it is a worse failure than one
    // that names what is missing.
    expect(renderSkill('Review {{diff}}', {})).toBe('Review {{diff}}');
  });

  test('whitespace inside the braces is tolerated', () => {
    expect(renderSkill('Review {{ diff }}', { diff: 'D' })).toBe('Review D');
  });
});
