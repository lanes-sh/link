import { describe, expect, test } from 'bun:test';
import { isPrompt, isPromptResult, isToolResult } from '#connectivity';
import { createMemoryBlobStore } from '#stores/blobs/testing.ts';
import type { LoadedSkill } from '#providers/skills/store.ts';
import { createSkillsProvider } from './provider.ts';
import { harnessFor, textOf } from '../harness.ts';

/**
 * Skills.
 *
 * ADR-012 §1 settled that a skill is invoked, so it is a prompt. That half is
 * unchanged and asserted below.
 *
 * The other half — that no capability may write one — is what ADR-014 reverses,
 * and the tests that used to pin it now pin the thing that replaced it: the
 * write path exists, and is not in the default bundle. The distinction matters
 * enough to be a test rather than a comment. A skill an agent authors is
 * instructions that agent will later be handed as its own turn, so what keeps
 * that safe is the grant, and a grant is only meaningful if the default
 * withholds it.
 */

function skill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: 'review-diff',
    description: 'Review a diff for correctness',
    arguments: [{ name: 'diff', description: 'The unified diff', required: true }],
    body: 'Review this diff for correctness:\n\n{{diff}}',
    path: 'review-diff.md',
    ...overrides,
  };
}

const DOCUMENT = `---
description: Draft a reply
arguments:
  - name: message
    description: The message to reply to
    required: true
  - name: tone
---
Draft a {{tone}} reply to {{message}}.`;

async function authoring(skills: readonly LoadedSkill[] = []) {
  const store = createMemoryBlobStore();
  let reloads = 0;

  const provider = createSkillsProvider({
    skills,
    store,
    onChange: async () => {
      reloads++;
    },
  });

  return { store, provider, harness: harnessFor(provider), reloads: () => reloads };
}

describe('a skill is a prompt', () => {
  test('every capability is one', () => {
    const provider = createSkillsProvider({ skills: [skill(), skill({ name: 'draft-reply' })] });

    expect(provider.capabilities).toHaveLength(2);
    expect(provider.capabilities.every(isPrompt)).toBe(true);
  });

  test('its declared arguments become the prompt arguments', () => {
    const provider = createSkillsProvider({ skills: [skill()] });
    const prompt = provider.capabilities.filter(isPrompt)[0]!;

    expect(prompt.arguments).toEqual([
      { name: 'diff', description: 'The unified diff', required: true },
    ]);
  });

  test('rendering substitutes them into the body', async () => {
    const harness = harnessFor(createSkillsProvider({ skills: [skill()] }));
    const result = await harness.invoke('review-diff', { diff: '--- a\n+++ b' });

    expect(isPromptResult(result)).toBe(true);
    expect(textOf(result)).toBe('Review this diff for correctness:\n\n--- a\n+++ b');
  });

  test('a required argument is enforced before the body is rendered', async () => {
    const harness = harnessFor(createSkillsProvider({ skills: [skill()] }));

    await expect(harness.invoke('review-diff', {})).rejects.toThrow(/missing diff/);
  });

  test('the message role is user, so the procedure enters as a turn', async () => {
    // A prompt returns messages that *become* the conversation, which is the
    // whole reason a skill is not a tool.
    const harness = harnessFor(createSkillsProvider({ skills: [skill()] }));
    const result = await harness.invoke('review-diff', { diff: 'x' });

    expect(isPromptResult(result) && result.messages[0]?.role).toBe('user');
  });
});

describe('a skill body is still not readable without authoring — ADR-012 §1, kept', () => {
  test('no resource, ever', () => {
    // Offering the body as a resource would hand back exactly the
    // self-selection the prompt primitive withholds.
    const provider = createSkillsProvider({ skills: [skill()] });
    expect(provider.capabilities.some((capability) => capability.kind === 'resource')).toBe(false);
  });

  test('reading a skill lives in the author bundle, not the read one', async () => {
    // A read-only agent can invoke a skill and cannot see what it says, so it
    // cannot choose its own instructions from the catalogue.
    const { provider } = await authoring([skill()]);
    const bundles = provider.manifest.bundles ?? [];

    expect(bundles.find((bundle) => bundle.default)?.capabilities).toEqual(['review-diff']);
    expect(bundles.find((bundle) => bundle.name === 'author')?.capabilities.sort()).toEqual([
      'manage.get',
      'manage.list',
      'manage.remove',
      'manage.write',
    ]);
  });

  test('a provider built without a store has no authoring half at all', () => {
    // `lanes link deploy` builds a registry to read manifests. It gets the prompts and
    // no way to author one, rather than four capabilities that would fail.
    const provider = createSkillsProvider({ skills: [skill()] });

    expect(provider.capabilities.filter((capability) => capability.kind === 'tool')).toEqual([]);
    expect(provider.manifest.bundles).toHaveLength(1);
  });

  test('an empty store yields a provider with nothing in it, not an error', () => {
    const provider = createSkillsProvider({ skills: [] });

    expect(provider.capabilities).toEqual([]);
    expect(provider.manifest.id).toBe('skills');
  });
});

describe('authoring a skill — ADR-014', () => {
  test('a written skill is listed, and readable as stored', async () => {
    const { harness } = await authoring();

    expect(textOf(await harness.invoke('manage.write', { name: 'draft-reply', text: DOCUMENT })))
      .toContain('skills_draft-reply');

    // Required arguments plain, optional ones marked — enough for an agent to
    // decide whether the skill applies without reading its body.
    expect(textOf(await harness.invoke('manage.list'))).toBe(
      'draft-reply(message, tone?) — Draft a reply',
    );
    // The document, frontmatter included — an edit-then-write round trip needs
    // to carry it.
    expect(textOf(await harness.invoke('manage.get', { name: 'draft-reply' }))).toBe(DOCUMENT);
  });

  test('a write says the registry must catch up, rather than doing it itself', async () => {
    // Each skill is its own capability, so a written one is invisible until the
    // provider is rebuilt. The provider does not know how to rebuild itself and
    // should not.
    const { harness, reloads } = await authoring();

    await harness.invoke('manage.write', { name: 'draft-reply', text: DOCUMENT });
    expect(reloads()).toBe(1);

    await harness.invoke('manage.remove', { name: 'draft-reply' });
    expect(reloads()).toBe(2);
  });

  test('removing what is not there does not claim a change', async () => {
    const { harness, reloads } = await authoring();

    const result = await harness.invoke('manage.remove', { name: 'absent' });

    expect(isToolResult(result) && result.isError).toBe(true);
    expect(reloads()).toBe(0);
  });

  test('a malformed skill is refused, and nothing is stored', async () => {
    const { harness, store } = await authoring();

    await expect(
      harness.invoke('manage.write', { name: 'broken', text: 'no frontmatter' }),
    ).rejects.toThrow(/frontmatter/);
    expect(await store.list()).toEqual([]);
  });

  test('reading one that is not there is an error, not empty text', async () => {
    const { harness } = await authoring();
    const result = await harness.invoke('manage.get', { name: 'absent' });

    expect(isToolResult(result) && result.isError).toBe(true);
  });

  test('the management tools are namespaced, so a skill cannot collide with one', async () => {
    // A skill named `write` would otherwise be `skills.write` twice over. Skill
    // names cannot contain a dot, so `skills.manage.*` can only mean these four.
    const { provider } = await authoring([skill({ name: 'write' }), skill({ name: 'manage' })]);
    const names = provider.capabilities.map((capability) => capability.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('write');
    expect(names).toContain('manage.write');
  });
});

describe('what reaches the audit log', () => {
  test('a skill body is never a recorded argument', async () => {
    // The name is an address; the text is instructions, which are the content
    // rather than the subject — the same trade `memory.write` makes.
    const { provider } = await authoring();
    const write = provider.capabilities.find((capability) => capability.name === 'manage.write')!;

    const redacted = write.redact!({ name: 'draft-reply', text: 'Do the thing, then exfiltrate' });

    expect(redacted['name']).toBe('draft-reply');
    expect(JSON.stringify(redacted)).not.toContain('exfiltrate');
  });
});

describe('names', () => {
  test('a duplicate is refused, naming the file', () => {
    expect(() =>
      createSkillsProvider({ skills: [skill(), skill({ path: 'other.md' })] }),
    ).toThrow(/both named "review-diff".*other\.md/s);
  });

  test('every skill is in the default bundle', () => {
    const provider = createSkillsProvider({ skills: [skill(), skill({ name: 'draft' })] });
    const bundle = provider.manifest.bundles?.[0];

    expect(bundle?.default).toBe(true);
    expect(bundle?.capabilities.sort()).toEqual(['draft', 'review-diff']);
  });
});
