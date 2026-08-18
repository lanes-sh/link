import { heading, print, style } from '../../output.ts';
import { assetState, plannedAssets, readAsset } from './assets.ts';
import { HARNESSES, type Harness } from './harnesses.ts';
import { exists } from './register.ts';

/**
 * `lanes link mcp list` — where this endpoint is registered, and whether what
 * each harness has been told about it is still what we ship.
 *
 * Two columns because there are two ways to be half set up, and they have
 * different fixes. A registration without the skill is a working endpoint
 * nobody reaches for; a skill against no registration is a document describing
 * tools that are not there.
 */
export async function mcpList(options: { name?: string | undefined; scope?: string | undefined }): Promise<void> {
  const name = options.name ?? 'lanes-link';
  const scope = options.scope ?? 'user';

  heading(`Registered as ${style.bold(name)}`);

  for (const harness of HARNESSES) {
    const binary = Bun.which(harness.binary);

    if (!binary) {
      print(`  ${harness.label.padEnd(14)} ${style.dim('not installed')}`);
      continue;
    }

    print(
      `  ${harness.label.padEnd(14)} ${
        exists(binary, harness, name)
          ? style.green('registered')
          : style.dim(`not registered — lanes link mcp add ${harness.id}`)
      }`,
    );

    for (const line of await documentLines(harness, scope)) print(`  ${' '.repeat(14)} ${line}`);
  }
}

/** One line per document this harness can hold, saying whether it is current. */
async function documentLines(harness: Harness, scope: string): Promise<string[]> {
  const lines: string[] = [];

  for (const plan of plannedAssets(harness, scope)) {
    try {
      const state = await assetState(plan, await readAsset(plan.asset));

      lines.push(
        state === 'current'
          ? style.dim(`${plan.asset.label}: `) + style.green('up to date')
          : style.dim(
              state === 'stale'
                ? `${plan.asset.label}: out of date — lanes link mcp add ${harness.id}`
                : `${plan.asset.label}: not installed — lanes link mcp add ${harness.id}`,
            ),
      );
    } catch (error) {
      // A checkout without `instructions/` — a container image, say. Worth one
      // line rather than a thrown error that hides the registration column.
      lines.push(style.dim(`${plan.asset.label}: ${message(error)}`));
    }
  }

  return lines;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
