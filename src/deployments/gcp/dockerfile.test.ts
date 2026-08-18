import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';

/**
 * The image has to build from a clean checkout.
 *
 * That is what makes one image able to serve any workspace, and it is the
 * property that regresses silently: adding `COPY lanes-link.yaml ./` back works
 * perfectly for whoever adds it, because their workspace is sitting in the
 * repository root. It fails only for someone who has just cloned, or for a
 * build meant to be published — neither of whom is in the room at the time.
 *
 * So the check is against `.gitignore`, which is the definition of "not in a
 * fresh clone", rather than against the filesystem, where the file is present.
 */

const DOCKERFILE = new URL('./Dockerfile', import.meta.url).pathname;
const GITIGNORE = new URL('../../../.gitignore', import.meta.url).pathname;

/** The sources of every `COPY`, minus the destination and any flags. */
function copySources(dockerfile: string): string[] {
  const sources: string[] = [];

  for (const line of dockerfile.split('\n')) {
    const match = /^COPY\s+(.+)$/.exec(line.trim());
    if (!match) continue;

    const parts = match[1]!.split(/\s+/).filter((part) => !part.startsWith('--'));
    sources.push(...parts.slice(0, -1)); // the last is the destination
  }
  return sources;
}

/** Ignore patterns, minus comments, blanks, and re-inclusions. */
function ignoredPatterns(gitignore: string): string[] {
  return gitignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'));
}

/** Whether a COPY source would be missing from a fresh clone. */
function isIgnored(source: string, patterns: readonly string[]): boolean {
  const normalised = source.replace(/^\.\//, '').replace(/\/$/, '');

  return patterns.some((pattern) => {
    const bare = pattern.replace(/^\//, '').replace(/\/$/, '');
    if (bare === normalised) return true;
    // A directory pattern covers everything beneath it.
    if (normalised.startsWith(`${bare}/`)) return true;
    // `profiles/*.yaml` and the like.
    if (bare.includes('*')) {
      const expression = new RegExp(`^${bare.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}$`);
      return expression.test(normalised);
    }
    return false;
  });
}

describe('the deployed image', () => {
  test('copies nothing that a fresh clone would not have', async () => {
    const sources = copySources(await readFile(DOCKERFILE, 'utf8'));
    const patterns = ignoredPatterns(await readFile(GITIGNORE, 'utf8'));

    expect(sources.filter((source) => isIgnored(source, patterns))).toEqual([]);
  });

  test('copies exactly what it needs and nothing else', async () => {
    // An allowlist, so adding a COPY is a deliberate act rather than a diff
    // nobody reads. Every entry here is tracked; the test above is what keeps
    // that true as `.gitignore` changes.
    const sources = copySources(await readFile(DOCKERFILE, 'utf8'));

    expect([...sources].sort()).toEqual(['bun.lock', 'bunfig.toml', 'package.json', 'src/']);
  });

  test("does not copy the workspace, which is the operator's and not the image's", async () => {
    // Config lives wherever LANES_LINK_HOME points now (ADR-023). Baking it
    // back in trips the tests above too, but this one names the intent so the
    // failure reads as "you meant not to do this".
    const sources = copySources(await readFile(DOCKERFILE, 'utf8'));

    expect(sources).not.toContain('lanes-link.yaml');
    expect(sources).not.toContain('profiles/');
    expect(sources).not.toContain('providers/');
  });

  test('never copies data/, which holds the credential store and its key', async () => {
    // `.dockerignore` excludes it as well; this is the belt. That exclusion is
    // a security control rather than an image-size optimisation, and a bare
    // `COPY . .` would defeat it without tripping anything else here.
    const dockerfile = await readFile(DOCKERFILE, 'utf8');

    expect(copySources(dockerfile)).not.toContain('data/');
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/m);
  });

  test('the workspace root is not baked in', async () => {
    // A bucket URL belongs to the operator, and `lanes link deploy` passes it
    // at rollout. An ENV here would take effect only when the deploy stopped
    // setting one, which is the confusing half of that bug.
    expect(await readFile(DOCKERFILE, 'utf8')).not.toMatch(/^ENV LANES_LINK_HOME=/m);
  });
});
