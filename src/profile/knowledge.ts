import { z } from 'zod';
import { credentialRef } from './primitives.ts';

/**
 * Where a profile's memory, skills and entities live, when that is not where
 * everything else lives.
 *
 * A target's `storage:` block names one backend for everything a profile holds
 * — runtime state, the audit log, memory entries, skills, cached attachments.
 * That is right for most of it and wrong for three: state and the log are
 * artefacts of one installation, and memory entries, skills and entity files
 * are documents the owner wrote. Documents want history, review, and to be
 * readable from more than one machine, and the backend that suits an object
 * nobody reads is not the backend that suits those.
 *
 * ADR-041 said "memory and skills, and nothing else", and ADR-056 amends the
 * count without touching the rule. That exclusion was never arithmetic: its
 * argument is a discriminator — an artefact of one installation stays, a
 * document the owner wrote may move — and an entity file is a Markdown document
 * with frontmatter, hand-editable, wanting history and review. It is on the
 * same side of that line as a memory entry, by the same test.
 *
 * So this block moves exactly those three, and it is the whole of what it can
 * move. There is no `credentials` or `vault` value here and there will not be:
 * a repository is a place to publish, and those two hold the material whose
 * entire value is that it is not published (`https://lanes.sh/docs/link/security`). The
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
 * Three directories, named after the three things that move — and named for a
 * *reader*, because a knowledge repository is somebody's own and they browse it
 * on GitHub. `memory/` is what belongs at the top of that tree, not
 * `lanes_memory/`.
 *
 * **This used to be the provider's blob prefix as well**, on the reasoning that
 * one word doing both jobs could not come to disagree with itself. Contract 4
 * prefixed the owner layer (`lanes_memory`), so the two are no longer the same
 * string and the choice has to be made rather than avoided: the route below
 * reads `PROVIDER_PREFIX`, and this stays the readable name. `KNOWLEDGE_ROUTES`
 * pairs them in one place so a rename still cannot move one without the other.
 *
 * Declared here, beside the schema, so the runtime that opens these stores and
 * the command that migrates into them read one definition.
 */
export const KNOWLEDGE_LAYOUT = {
  memory: 'memory',
  skills: 'skills',
  entities: 'entities',
} as const;

export type KnowledgeArea = keyof typeof KNOWLEDGE_LAYOUT;

/** The blob prefix each area is scoped into locally — the provider's own id. */
export const KNOWLEDGE_PREFIX = {
  memory: 'lanes_memory',
  skills: 'lanes_skills',
  entities: 'lanes_entities',
} as const;

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
