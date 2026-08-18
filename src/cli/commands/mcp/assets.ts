import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installRoot } from '#profile';
import { print, style } from '../../output.ts';
import type { Harness } from './harnesses.ts';

/**
 * The documents this repository ships *to* a client, and how they get there.
 *
 * They live under `instructions/` — one root, because they are one thing said
 * three ways. The MCP server says the short version of it to every client that
 * connects (`server/mcp/instructions.ts`); these two are the long version, for
 * the harnesses that can hold a file.
 *
 * Deliberately not read by the server. `.dockerignore` keeps `instructions/`
 * out of the image, so a deployed revision has no copy of either — which is
 * exactly why the endpoint describes itself from code instead.
 */

export type AssetKind = 'skill' | 'agent';

export interface BundledAsset {
  readonly kind: AssetKind;
  /** Under `instructions/` here. */
  readonly source: string;
  /** Under the harness's directory for that kind, once installed. */
  readonly target: string;
  readonly label: string;
}

export const ASSETS: readonly BundledAsset[] = [
  {
    kind: 'skill',
    source: 'skills/lanes-link/SKILL.md',
    // A directory rather than a flat `lanes-link.md`, so a skill that later
    // grows a reference or a script has somewhere to put it without moving.
    target: 'lanes-link/SKILL.md',
    label: 'skill',
  },
  {
    kind: 'agent',
    source: 'agents/lanes-link-scout.md',
    target: 'lanes-link-scout.md',
    label: 'scout agent',
  },
];

/** Where an asset lives in this checkout. */
export function sourcePath(asset: BundledAsset): string {
  return join(installRoot(import.meta.dir), 'instructions', asset.source);
}

export async function readAsset(asset: BundledAsset): Promise<string> {
  const path = sourcePath(asset);

  if (!existsSync(path)) {
    throw new Error(
      `The bundled ${asset.label} is missing from ${path}. ` +
        `It ships in the repository under instructions/${asset.source}.`,
    );
  }

  return readFile(path, 'utf8');
}

export interface AssetPlan {
  readonly asset: BundledAsset;
  readonly path: string;
}

/**
 * What this harness would receive, at this scope.
 *
 * A harness with no directory for a kind simply contributes nothing for it —
 * Codex takes the skill and has nowhere to put a subagent, and that is a fact
 * about Codex rather than a failure to report.
 */
export function plannedAssets(harness: Harness, scope: string): AssetPlan[] {
  const plans: AssetPlan[] = [];

  for (const asset of ASSETS) {
    const directory = asset.kind === 'skill' ? harness.skills?.(scope) : harness.agents?.(scope);
    if (directory) plans.push({ asset, path: join(directory, asset.target) });
  }

  return plans;
}

export type AssetState = 'installed' | 'updated' | 'unchanged';

/**
 * Write one asset, reporting what that actually changed.
 *
 * Compared before writing rather than written unconditionally, for two reasons
 * that are both about the second run. It makes re-running honest — "unchanged"
 * is different information from "updated", and someone re-running after a token
 * rotation wants to know the document did not move under them. And it keeps the
 * file's mtime still, which matters because a harness that watches its skills
 * directory would otherwise reload on every `mcp add`.
 */
export async function installAsset(plan: AssetPlan, body: string): Promise<AssetState> {
  const existing = existsSync(plan.path) ? await readFile(plan.path, 'utf8') : null;
  if (existing === body) return 'unchanged';

  await mkdir(dirname(plan.path), { recursive: true });
  await writeFile(plan.path, body);

  return existing === null ? 'installed' : 'updated';
}

/** Whether what is on disk is what we ship, without writing anything. */
export async function assetState(
  plan: AssetPlan,
  body: string,
): Promise<'current' | 'stale' | 'missing'> {
  if (!existsSync(plan.path)) return 'missing';
  return (await readFile(plan.path, 'utf8')) === body ? 'current' : 'stale';
}

/**
 * Install every asset this harness takes, and say what happened to each.
 *
 * Errors are reported rather than thrown: a read-only home directory should not
 * abandon a registration that already succeeded, and the operator can still
 * install by hand from `lanes link mcp skill`.
 */
export async function installFor(
  harness: Harness,
  scope: string,
  options: { dryRun?: boolean | undefined },
): Promise<void> {
  for (const plan of plannedAssets(harness, scope)) {
    if (options.dryRun) {
      print(style.dim(`      would write ${plan.asset.label} to ${plan.path}`));
      continue;
    }

    try {
      const state = await installAsset(plan, await readAsset(plan.asset));
      print(
        style.dim(
          state === 'unchanged'
            ? `      ${plan.asset.label} already current at ${plan.path}`
            : `      ${state} ${plan.asset.label} at ${plan.path}`,
        ),
      );
    } catch (error) {
      print(style.dim(`      could not install the ${plan.asset.label}: ${message(error)}`));
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `lanes link mcp skill` — the bundled skill, as a path or as the document.
 *
 * Still here after `mcp add` learned to install it, because it is the answer for
 * every client that has no skills directory to install into: Claude Desktop,
 * Cowork, and anything else that reads a URL and nothing else. `--print` sends
 * the document to stdout so it can be piped somewhere this CLI has never heard
 * of.
 */
export async function skillDocument(options: { print?: boolean | undefined }): Promise<void> {
  const asset = ASSETS.find((candidate) => candidate.kind === 'skill')!;
  const body = await readAsset(asset);

  if (options.print) {
    print(body.trimEnd());
    return;
  }

  const directory = dirname(sourcePath(asset));
  print(directory);
  print('');
  print(style.dim('Installed for you by "lanes link mcp add". By hand, for Claude Code:'));
  print(`  cp -r ${directory} ~/.claude/skills/`);
  print('');
  print(
    style.dim(
      'For a client with nowhere to put a file, "lanes link mcp skill --print" writes the\n' +
        'document to stdout — though such a client is already told the short version of it\n' +
        'by the endpoint itself, when it connects.',
    ),
  );
}
