import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import type { ProviderManifest } from '#connectivity';
import { layout } from '#profile';
import { parseManifest } from '#providers/custom/index.ts';

/**
 * Putting the manifest where the loader will find it.
 *
 * The only filesystem code in this command, and the only place that decides what
 * the file looks like. Writing is local: a deployed revision reads its
 * manifests from a bucket but never writes its own config (ADR-007), so the
 * operator's workspace is where a declaration is authored and `deploy` or the
 * publish that follows a connect is what carries it.
 */

/** Where this profile keeps its own declarations. */
export function manifestPath(workspaceRoot: string, profile: string, id: string): string {
  return join(workspaceRoot, layout.providers(), `${id}.yaml`);
}

/**
 * Fields this command never writes, so a hand-added one is not a difference.
 *
 * The file belongs to the operator the moment it exists. `redact` and `hints`
 * are exactly what somebody adds after seeing the tool list — per-capability
 * argument keys worth recording, and prose the vendor's own description leaves
 * out — and a re-run must not read them as drift.
 */
const THEIRS = ['redact', 'hints', 'bundles'];

/**
 * One header line, about the file rather than about the fields.
 *
 * `manifestTemplate` is the other way round and stays that way: it is teaching
 * material whose values are deliberately wrong and whose comments explain each
 * field. This is a record of what somebody just said, where every value is
 * theirs — so a comment describing a field would end up describing a different
 * provider than the value beside it, and every optional field they declined
 * would sit in the file as a value that now *is* declared.
 */
const HEADER =
  '# Written by `lanes link connect custom`. Yours to edit from here —\n' +
  '# `lanes link connect <id>` re-reads this file every time.\n';

export function renderManifest(declaration: Record<string, unknown>): string {
  return HEADER + stringify(declaration, { lineWidth: 0 });
}

/** The manifest already at this path, or null. Parsed, so defaults match. */
export async function readExistingManifest(path: string): Promise<ProviderManifest | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }

  // Deliberately `parseManifest` and not the loader's file variant: a relative
  // `openapi` must compare as it was written, not as it resolves, or every
  // re-run reads as a change.
  return parseManifest(text, path);
}

/**
 * Where a re-run would differ from what is on disk, as dotted paths.
 *
 * Compared as parsed manifests rather than as bytes, so both sides have the same
 * defaults applied and neither key order nor a reflowed line reads as drift.
 * Both directions, minus `THEIRS`: dropping `--operations` from a second run is
 * a real difference, and answering "unchanged" there would leave a filter in
 * place that the operator has just stopped asking for.
 */
export function manifestDiff(derived: ProviderManifest, existing: ProviderManifest): string[] {
  const differences: string[] = [];

  const walk = (a: unknown, b: unknown, path: string): void => {
    if (path.length > 0 && THEIRS.includes(path.split('.')[0]!)) return;

    if (Array.isArray(a) || Array.isArray(b)) {
      if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(describe(path, a, b));
      return;
    }

    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        walk(a[key], b[key], path.length > 0 ? `${path}.${key}` : key);
      }
      return;
    }

    if (a !== b) differences.push(describe(path, a, b));
  };

  walk(derived, existing, '');
  return differences.sort();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

function describe(path: string, derived: unknown, existing: unknown): string {
  return `${path}: ${show(existing)} → ${show(derived)}`;
}

const show = (value: unknown): string =>
  value === undefined ? '(absent)' : typeof value === 'string' ? value : JSON.stringify(value);

/** Write through a temp file, so a crash cannot leave half a declaration. */
export async function writeManifest(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  // `.tmp` because the filesystem blob store skips that suffix when it lists —
  // so a crash between write and rename leaves a file the loader will not try to
  // parse, rather than one that breaks every command for this profile.
  const temporary = `${path}.tmp`;
  await writeFile(temporary, text, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * That an OpenAPI document named as a path is actually there.
 *
 * Checked before the manifest is written, because the alternative is bleak:
 * discovery is the only thing that reads the spec, `openRuntime` swallows a
 * discovery failure so startup survives a provider that is merely unreachable,
 * and the result is a provider registered with zero capabilities and nothing
 * anywhere saying why.
 *
 * A relative path resolves against `providers.d/`, which is what
 * `resolveSpecPath` does when the loader reads it — and is almost never what
 * somebody typing `./spec.json` at a shell prompt means. So when it is missing
 * there and present in the working directory, say both.
 */
export async function checkOpenapiReachable(
  value: string,
  workspaceRoot: string,
  profile: string,
): Promise<void> {
  if (/^https?:/i.test(value)) return;

  const beside = isAbsolute(value)
    ? value
    : resolve(join(workspaceRoot, layout.providers()), value);

  if (await exists(beside)) return;

  const here = isAbsolute(value) ? undefined : resolve(process.cwd(), value);
  const alsoLookedAt =
    here && here !== beside && (await exists(here))
      ? `\n  It does exist at ${here}. A relative path in a manifest resolves against the manifest, ` +
        'not against wherever you ran this from — copy it beside the manifest, or give an absolute ' +
        'path or a URL.'
      : '';

  throw new Error(`No OpenAPI document at ${beside}.${alsoLookedAt}`);
}

const exists = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
};
