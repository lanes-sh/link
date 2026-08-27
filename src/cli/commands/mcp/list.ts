import { emit, heading, print, style } from '../../output.ts';
import { assetState, plannedAssets, readAsset } from './assets.ts';
import { HARNESSES, type Harness } from './harnesses.ts';
import { exists } from './register.ts';

/** Why a document this harness can hold is not what we ship, if it is not. */
export type DocumentState = 'current' | 'stale' | 'missing' | 'unreadable';

export interface ListedDocument {
  readonly label: string;
  readonly path: string;
  readonly state: DocumentState;
  /** Only for `unreadable` — what went wrong reading the bundled copy. */
  readonly detail?: string;
}

export interface ListedHarness {
  readonly id: string;
  readonly label: string;
  readonly installed: boolean;
  /** The resolved binary, so a caller can see *which* claude answered. */
  readonly binary: string | null;
  readonly registered: boolean;
  /**
   * Empty when the harness is not installed, matching what the text rendering
   * says: with no binary there is nothing to register the documents against, and
   * reporting them would describe a setup that does not exist.
   */
  readonly documents: readonly ListedDocument[];
}

export interface McpListing {
  readonly name: string;
  readonly scope: string;
  readonly harnesses: readonly ListedHarness[];
}

export interface McpListFlags {
  readonly name?: string | undefined;
  readonly scope?: string | undefined;
  readonly json?: boolean | undefined;
}

/**
 * `lanes link mcp list` — where this endpoint is registered, and whether what
 * each harness has been told about it is still what we ship.
 *
 * Two columns because there are two ways to be half set up, and they have
 * different fixes. A registration without the skill is a working endpoint
 * nobody reaches for; a skill against no registration is a document describing
 * tools that are not there.
 *
 * The listing is gathered before anything is printed, so `--json` and the text
 * rendering describe the same snapshot rather than two probes taken a moment
 * apart. `--json` exists because this is the one command another program has a
 * reason to read: it is how a UI decides between "add" and "re-add", and the
 * `stale` state is the only signal that a re-run would do something.
 */
export async function mcpList(options: McpListFlags): Promise<void> {
  const name = options.name ?? 'lanes-link';
  const scope = options.scope ?? 'user';

  const listing = await listRegistrations(name, scope);

  await emit(options.json, listing, () => render(listing));
}

/** The whole answer, gathered. No printing, so a caller can have it as data. */
export async function listRegistrations(name: string, scope: string): Promise<McpListing> {
  const harnesses: ListedHarness[] = [];

  for (const harness of HARNESSES) {
    const binary = Bun.which(harness.binary);

    if (!binary) {
      harnesses.push({
        id: harness.id,
        label: harness.label,
        installed: false,
        binary: null,
        registered: false,
        documents: [],
      });
      continue;
    }

    harnesses.push({
      id: harness.id,
      label: harness.label,
      installed: true,
      binary,
      registered: exists(binary, harness, name),
      documents: await documents(harness, scope),
    });
  }

  return { name, scope, harnesses };
}

/** One entry per document this harness can hold, saying whether it is current. */
async function documents(harness: Harness, scope: string): Promise<ListedDocument[]> {
  const listed: ListedDocument[] = [];

  for (const plan of plannedAssets(harness, scope)) {
    try {
      listed.push({
        label: plan.asset.label,
        path: plan.path,
        state: await assetState(plan, await readAsset(plan.asset)),
      });
    } catch (error) {
      // A checkout without `instructions/` — a container image, say. Worth one
      // line rather than a thrown error that hides the registration column.
      listed.push({
        label: plan.asset.label,
        path: plan.path,
        state: 'unreadable',
        detail: message(error),
      });
    }
  }

  return listed;
}

function render(listing: McpListing): void {
  heading(`Registered as ${style.bold(listing.name)}`);

  for (const harness of listing.harnesses) {
    if (!harness.installed) {
      print(`  ${harness.label.padEnd(14)} ${style.dim('not installed')}`);
      continue;
    }

    print(
      `  ${harness.label.padEnd(14)} ${
        harness.registered
          ? style.green('registered')
          : style.dim(`not registered — lanes link mcp add ${harness.id}`)
      }`,
    );

    for (const document of harness.documents) {
      print(`  ${' '.repeat(14)} ${documentLine(harness.id, document)}`);
    }
  }
}

function documentLine(id: string, document: ListedDocument): string {
  switch (document.state) {
    case 'current':
      return style.dim(`${document.label}: `) + style.green('up to date');
    case 'stale':
      return style.dim(`${document.label}: out of date — lanes link mcp add ${id}`);
    case 'missing':
      return style.dim(`${document.label}: not installed — lanes link mcp add ${id}`);
    case 'unreadable':
      return style.dim(`${document.label}: ${document.detail}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
