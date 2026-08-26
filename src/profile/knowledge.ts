import { z } from 'zod';
import { credentialRef } from './primitives.ts';

/**
 * Where a profile's memory and skills live, when that is not where everything
 * else lives.
 *
 * A target's `storage:` block names one backend for everything a profile holds
 * — runtime state, the audit log, memory entries, skills, cached attachments.
 * That is right for most of it and wrong for two: state and the log are
 * artefacts of one installation, and memory entries and skills are documents
 * the owner wrote. Documents want history, review, and to be readable from more
 * than one machine, and the backend that suits an object nobody reads is not
 * the backend that suits those.
 *
 * So this block moves exactly those two, and it is the whole of what it can
 * move. There is no `credentials` or `vault` value here and there will not be:
 * a repository is a place to publish, and those two hold the material whose
 * entire value is that it is not published (`docs/detailed/security.md`). The
 * exclusion is structural — a field that does not exist cannot be set by
 * accident, by a flag, or by an operator following an example.
 *
 * `adapter` is an enum of one, the same shape `vaultTargetSchema` uses, so a
 * second host is a case rather than a schema rewrite.
 *
 * Absent means what has always happened, which is why every field that could
 * carry a default does. A profile written before this block existed loads
 * unchanged and stores its memory and skills exactly where it did.
 *
 * ADR-041.
 */

/**
 * `owner/name`, as GitHub spells it everywhere a person types one.
 *
 * A URL is deliberately not accepted. The browser URL, the SSH remote, and this
 * are three spellings of one value, and a schema that takes all three has to
 * normalise them somewhere — at which point the file no longer says what the
 * operator wrote. The CLI accepts a pasted URL and reduces it to this before
 * writing, which puts the leniency where a person is typing rather than in the
 * contract.
 */
const repository = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/,
    'must be "owner/name" — not a URL, and not a local path',
  );

/**
 * A directory inside the repository, for one that holds other things too.
 *
 * Normalised to no leading or trailing slash so `knowledge`, `/knowledge` and
 * `knowledge/` are one prefix rather than three key spaces that look identical
 * in a diff and address different objects.
 */
const repositoryPath = z
  .string()
  .refine((value) => !value.split('/').includes('..'), {
    message: 'must not contain ".." — it is a prefix inside the repository, not a path to walk',
  })
  .transform((value) => value.replace(/^\/+/, '').replace(/\/+$/, ''));

export const knowledgeTargetSchema = z.object({
  adapter: z.literal('github'),
  repo: repository,
  /**
   * Defaults at open time rather than here, to the repository's own default
   * branch. Writing `main` into every generated config would be a guess, and a
   * wrong one for anybody whose default is still `master` — a guess that then
   * fails as "branch not found" rather than as "you did not say".
   */
  branch: z.string().min(1).optional(),
  path: repositoryPath.optional(),
  /**
   * A reference, never the token.
   *
   * Its own ref rather than a reuse of the `github` provider connection's,
   * which holds a token for GitHub's MCP server. That one needs Contents:
   * *read*; this one needs Contents: *write*, has a different lifetime, and
   * should be revocable on its own — revoking an MCP connection must not
   * silently empty somebody's memory.
   */
  token_ref: credentialRef.default('knowledge/token'),
});

export type KnowledgeConfig = z.infer<typeof knowledgeTargetSchema>;

/**
 * Where each area sits inside the repository.
 *
 * Two directories, named after the two things that move. `memory` is also the
 * memory provider's own blob namespace — the prefix core scopes it into under
 * the profile's blob root — which is why the same word does both jobs: the
 * route that redirects it and the directory it lands in are the same fact, and
 * spelling them separately is how they would come to disagree.
 *
 * Declared here, beside the schema, so the runtime that opens these stores and
 * the command that migrates into them read one definition.
 */
export const KNOWLEDGE_LAYOUT = {
  memory: 'memory',
  skills: 'skills',
} as const;

export type KnowledgeArea = keyof typeof KNOWLEDGE_LAYOUT;

/** The directory one area occupies, under the profile's optional path prefix. */
export function knowledgeRoot(knowledge: KnowledgeConfig, area: KnowledgeArea): string {
  const directory = KNOWLEDGE_LAYOUT[area];
  return knowledge.path ? `${knowledge.path}/${directory}` : directory;
}

/** `owner/name`, out of whatever a person pasted. Null when it is not one. */
export function parseRepository(given: string): string | null {
  const trimmed = given
    .trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//i, '')
    .replace(/^(?:ssh:\/\/)?git@[^:]+[:/]/i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');

  return repository.safeParse(trimmed).success ? trimmed : null;
}
