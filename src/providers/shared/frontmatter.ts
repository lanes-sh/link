import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ConfigError } from '#profile';

/**
 * YAML frontmatter between `---` fences, and the Markdown body after it.
 *
 * Two owner-layer artifacts are stored this way — a skill and a memory entry —
 * and they parse identically on purpose. One file per thing, holding both its
 * metadata and its text, is what makes either of them hand-editable: an entry
 * whose title lived in a database row beside a body in a blob could not be
 * opened in an editor, and could go out of sync with itself.
 *
 * The format is the one every other tool that reads a skill file already uses,
 * which is the reason it was not invented here.
 */

export interface Frontmatter {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
}

/**
 * Split a document, refusing one whose frontmatter is absent or malformed.
 *
 * Each failure is reported as itself rather than as one generic message, and
 * `source` names the file in all of them: these are read from a directory a
 * person edits by hand, where "could not parse frontmatter" without a filename
 * or a reason is not a diagnosis.
 */
export function splitFrontmatter(text: string, source: string): Frontmatter {
  const normalised = stripBom(text);

  if (!normalised.startsWith('---')) {
    throw new ConfigError(
      `${source}: expected YAML frontmatter between "---" fences at the start of the file.`,
    );
  }

  const fences = splitAtFences(normalised);
  if (!fences) {
    throw new ConfigError(`${source}: the frontmatter block is never closed with "---".`);
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fences.head);
  } catch (error) {
    throw new ConfigError(`${source}: could not parse frontmatter — ${(error as Error).message}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`${source}: the frontmatter must be a YAML mapping.`);
  }

  return { frontmatter: parsed as Record<string, unknown>, body: fences.body };
}

/**
 * Split a document that may not have frontmatter, treating the whole of it as
 * the body when it does not.
 *
 * A memory entry uses this rather than `splitFrontmatter`: entries are files in
 * a directory the owner is invited to edit, and a plain Markdown file dropped
 * in there should read as an untitled entry rather than becoming an error that
 * hides the rest of the directory behind it.
 */
export function splitOptionalFrontmatter(text: string): Frontmatter {
  const normalised = stripBom(text);
  if (!normalised.startsWith('---')) return { frontmatter: {}, body: normalised };

  const fences = splitAtFences(normalised);
  if (!fences) return { frontmatter: {}, body: normalised };

  let parsed: unknown;
  try {
    parsed = parseYaml(fences.head);
  } catch {
    return { frontmatter: {}, body: normalised };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { frontmatter: {}, body: normalised };
  }

  return { frontmatter: parsed as Record<string, unknown>, body: fences.body };
}

/** Serialise frontmatter and a body back into one document. */
export function withFrontmatter(data: Record<string, unknown>, body: string): string {
  const head = stringifyYaml(data).trimEnd();
  return `---\n${head}\n---\n\n${body.replace(/^\n+/, '')}`;
}

/** A frontmatter value that should be a list of strings, tolerating a bare one. */
export function stringList(raw: unknown): string[] {
  if (typeof raw === 'string') return [raw];
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string');
}

function splitAtFences(normalised: string): { head: string; body: string } | null {
  const end = normalised.indexOf('\n---', 3);
  if (end === -1) return null;

  const rest = normalised.slice(normalised.indexOf('\n', end + 1) + 1);

  return {
    head: normalised.slice(normalised.indexOf('\n') + 1, end),
    // One blank line after the closing fence is the conventional separator, not
    // content. Exactly one is dropped, so a body that deliberately opens with
    // blank lines keeps the rest of them — and so `withFrontmatter` round-trips
    // a body back to itself.
    body: rest.startsWith('\n') ? rest.slice(1) : rest,
  };
}

function stripBom(text: string): string {
  return text.replace(/^﻿/, '');
}
