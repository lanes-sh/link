import type { BlobStore } from '#stores/blobs';
import { splitFrontmatter } from '#providers/shared/frontmatter.ts';
import { ConfigError } from '#profile';

/**
 * Skills the owner has written.
 *
 * A skill is a **document in the owner layer's store**, which locally is a file
 * in `<workspace>/skills/` — the same place, in the same format, as before the
 * store existed. Going through `BlobStore` rather than `node:fs` is what lets a
 * deployed instance have skills at all: a filesystem path is baked into a
 * container image at build time, and an S3 key is not.
 *
 * Two layouts, because both are conventional and neither is worth refusing:
 *
 *     skills/review-diff.md
 *     skills/review-diff/SKILL.md
 *
 * Frontmatter is YAML between `---` fences, matching every other tool that
 * reads a skill file. `description` is the only required key; the body after
 * the fence is the prompt.
 *
 * **A skill can now be written, which ADR-012 §1 refused and ADR-014 reverses.**
 * The reversal is about the *write path existing*, not about who may use it:
 * authoring stays out of the default bundle, so an agent reaches it only where
 * policy says so, and the control plane reaches it always.
 */

export { WORKSPACE_SKILL_DIR } from '#profile';

/** The nested layout's filename, kept so a rewrite lands on the file it read. */
const NESTED = 'SKILL.md';

export interface SkillArgument {
  readonly name: string;
  readonly description: string;
  readonly required?: boolean;
}

export interface LoadedSkill {
  /** Becomes the capability name, so `skills.<name>` is what policy grants. */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly arguments: readonly SkillArgument[];
  readonly body: string;
  /** The store key it was read from — `review-diff.md` or `review-diff/SKILL.md`. */
  readonly path: string;
}

/**
 * Capability names reach policy rules and MCP wire names, and both are stricter
 * than a filename. Refused rather than slugified: a skill silently renamed is a
 * policy rule that silently stops matching.
 */
const SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function assertSkillName(name: string, source = 'skill'): void {
  if (!SKILL_NAME.test(name)) {
    throw new ConfigError(
      `${source}: skill name ${JSON.stringify(name)} must be lowercase letters, digits, "_" or "-" — ` +
        'it becomes the capability id "skills.<name>", which policy rules and MCP names both constrain.',
    );
  }
}

/**
 * Every skill in the store.
 *
 * A key that is not a skill is skipped rather than refused — a skill directory
 * legitimately holds references and scripts beside its `SKILL.md`, and one
 * unparseable file must not hide every other skill behind it. A file that *is*
 * a skill and is malformed still throws, because that one is a mistake the
 * owner wants to hear about.
 */
export async function loadWorkspaceSkills(store: BlobStore): Promise<LoadedSkill[]> {
  const keys = (await store.list()).map((blob) => blob.key).sort();
  const loaded: LoadedSkill[] = [];

  for (const key of keys) {
    const name = skillNameFor(key);
    if (name === null) continue;

    const bytes = await store.get(key);
    if (bytes === null) continue; // Listed then deleted; not worth failing over.

    loaded.push(parseSkill(new TextDecoder().decode(bytes), key, name));
  }

  return loaded;
}

/** Read one skill by name, or null when there is none. */
export async function readSkill(store: BlobStore, name: string): Promise<LoadedSkill | null> {
  const key = await skillKey(store, name);
  if (key === null) return null;

  const bytes = await store.get(key);
  if (bytes === null) return null;

  return parseSkill(new TextDecoder().decode(bytes), key, name);
}

/**
 * Create or replace a skill, validating it before it is stored.
 *
 * Parsed first so a malformed document is refused rather than persisted: a
 * skill that fails to load is invisible until the next start, at which point
 * the reason it broke is a long way from the write that broke it.
 *
 * An existing skill is rewritten **in the layout it already has**, so editing a
 * `review-diff/SKILL.md` does not silently leave a second `review-diff.md`
 * beside it — two files claiming one capability id, which the provider refuses
 * to build at all.
 *
 * A *new* one is written as `<name>/SKILL.md`, which is the shape `~/.claude`
 * uses and the shape the skill bundled with this repository already has. The
 * flat `<name>.md` still loads and is still rewritten in place; the directory is
 * the better default because a skill that grows a reference or a script has
 * somewhere to put it without moving first.
 */
export async function writeSkill(
  store: BlobStore,
  name: string,
  text: string,
): Promise<LoadedSkill> {
  assertSkillName(name);

  const key = (await skillKey(store, name)) ?? `${name}/${NESTED}`;
  const skill = parseSkill(text, key, name);

  if (skill.name !== name) {
    throw new ConfigError(
      `${key}: the frontmatter names this skill "${skill.name}", but it is being written as "${name}". ` +
        'Remove the "name" key to take it from the filename, or write it under the name it declares.',
    );
  }

  // No contentType: on the filesystem adapter that writes a `<key>.meta`
  // sidecar, and `<workspace>/skills/` is a directory the owner edits and
  // commits. Nothing reads a skill's stored content type.
  await store.put(key, new TextEncoder().encode(text));
  return skill;
}

/** Delete a skill in whichever layout holds it. Returns false when absent. */
export async function removeSkill(store: BlobStore, name: string): Promise<boolean> {
  const key = await skillKey(store, name);
  if (key === null) return false;

  await store.delete(key);
  return true;
}

/** Where a skill of this name lives today, in either layout. */
async function skillKey(store: BlobStore, name: string): Promise<string | null> {
  assertSkillName(name);

  const flat = `${name}.md`;
  if (await store.has(flat)) return flat;

  const nested = `${name}/${NESTED}`;
  return (await store.has(nested)) ? nested : null;
}

/**
 * The skill name a store key implies, or null when the key is not a skill.
 *
 * `review-diff.md` and `review-diff/SKILL.md` are skills. A file nested any
 * deeper, or named anything else inside a skill's own directory, belongs to
 * that skill and is not one itself.
 */
function skillNameFor(key: string): string | null {
  const segments = key.split('/');

  if (segments.length === 1) {
    const [file] = segments as [string];
    return file.endsWith('.md') ? file.slice(0, -'.md'.length) : null;
  }

  if (segments.length === 2 && segments[1] === NESTED) return segments[0]!;
  return null;
}

export function parseSkill(text: string, source: string, fallbackName: string): LoadedSkill {
  const { frontmatter, body } = splitFrontmatter(text, source);

  const name = typeof frontmatter['name'] === 'string' ? frontmatter['name'] : fallbackName;
  assertSkillName(name, source);

  const description = frontmatter['description'];
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new ConfigError(
      `${source}: a skill needs a "description" in its frontmatter. It is the only thing an agent ` +
        'sees when deciding whether this skill applies.',
    );
  }

  if (body.trim().length === 0) {
    throw new ConfigError(`${source}: the skill has no body, so there is no procedure to render.`);
  }

  return {
    name,
    ...(typeof frontmatter['title'] === 'string' ? { title: frontmatter['title'] } : {}),
    description,
    arguments: parseArguments(frontmatter['arguments'], source),
    body,
    path: source,
  };
}

function parseArguments(raw: unknown, source: string): SkillArgument[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new ConfigError(`${source}: "arguments" must be a list.`);
  }

  return raw.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = record['name'];

    if (typeof name !== 'string' || !SKILL_NAME.test(name)) {
      throw new ConfigError(
        `${source}: arguments[${index}] needs a lowercase "name" — it becomes a prompt argument.`,
      );
    }

    return {
      name,
      description: typeof record['description'] === 'string' ? record['description'] : name,
      ...(record['required'] === true ? { required: true } : {}),
    };
  });
}

/**
 * Substitute `{{argument}}` in a skill body.
 *
 * An argument the caller omitted leaves its placeholder in place rather than
 * becoming an empty string: a procedure that reads "review the diff below" with
 * nothing below it is a worse failure than one that visibly names what is
 * missing.
 */
export function renderSkill(body: string, args: Readonly<Record<string, string>>): string {
  return body.replace(/\{\{\s*([a-z0-9_-]+)\s*\}\}/gi, (placeholder, name: string) =>
    typeof args[name] === 'string' ? args[name]! : placeholder,
  );
}
