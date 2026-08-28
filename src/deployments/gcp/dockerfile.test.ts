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
const MANIFEST = new URL('../../../package.json', import.meta.url).pathname;

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

    expect([...sources].sort()).toEqual(['bun.lock*', 'bunfig.toml', 'package.json', 'src/']);
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

  test('requires nothing an npm install cannot receive', async () => {
    // The check `.gitignore` cannot make, and the one that had to be rewritten.
    //
    // A fresh clone and a published package are two different definitions of
    // "the file is there", and this Dockerfile ships inside the package — `files`
    // carries `src`, and it lives under it — so `lanes link deploy` builds from
    // whatever npm sent. `bun.lock` and `bunfig.toml` were not in `files` at all;
    // every other test here passed, because both are tracked and neither is
    // gitignored, and deploy from a bun-global install died at `COPY`.
    //
    // Adding them to `files` fixed one of the two and *looked* like it fixed
    // both. **npm removes a root lockfile from a tarball whatever `files`
    // says** — npm 12, which `release.yml` installs, strips `bun.lock`; npm 11.6
    // packs it. So a local `npm pack` confirmed a fix that had not shipped, and
    // the published 0.6.3 tarball had no lockfile in it.
    //
    // Which is why this asserts the *rule* rather than shelling out to whichever
    // npm happens to be on the machine — a test whose answer depends on that is
    // the same trap one layer down. A source npm strips has to be written as a
    // glob, so the build tolerates its absence; everything else has to be
    // shipped by `files`.
    const sources = copySources(await readFile(DOCKERFILE, 'utf8'));
    const files: string[] = JSON.parse(await readFile(MANIFEST, 'utf8')).files;

    // npm ships these whatever `files` says, so they need no entry.
    const always = ['package.json', 'README.md', 'LICENSE', 'LICENCE'];
    // …and removes these however hard you ask, but only at the package root.
    const stripped = ['bun.lock', 'bun.lockb', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'];

    const problems: string[] = [];
    for (const source of sources) {
      const bare = source.replace(/\/$/, '');
      if (bare.endsWith('*')) {
        // Optional by construction. Only worth writing that way for something
        // that can actually be missing.
        const named = bare.slice(0, -1);
        if (!stripped.includes(named)) problems.push(`${source} is optional but always ships`);
        continue;
      }
      if (stripped.includes(bare)) {
        problems.push(`${bare} is stripped from every tarball — copy it as "${bare}*"`);
        continue;
      }
      if (always.includes(bare)) continue;
      const shipped = files.some((entry) => {
        const listed = entry.replace(/^\.\//, '').replace(/\/$/, '');
        return listed === bare || bare.startsWith(`${listed}/`);
      });
      if (!shipped) problems.push(`${bare} is copied but not in "files"`);
    }

    expect({ problems, sources, files }).toEqual({ problems: [], sources, files });
  });

  test('installs against the lockfile when there is one, and says so when there is not', async () => {
    // The fallback must not be `--frozen-lockfile || bun install`: that turns a
    // real lockfile-versus-manifest disagreement in a checkout build into a
    // silent unpinned install, which is the one thing the frozen flag is for.
    // Instructions only. The comment above the RUN line names the anti-pattern
    // in order to rule it out, and a scan of the whole file reads that as the
    // thing itself.
    const instructions = (await readFile(DOCKERFILE, 'utf8'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

    expect(instructions).toContain('--frozen-lockfile');
    expect(instructions).not.toMatch(/--frozen-lockfile\s*\|\|/);
    expect(instructions).toMatch(/if \[ -f bun\.lock \]/);
  });

  test('the workspace root is not baked in', async () => {
    // A bucket URL belongs to the operator, and `lanes link deploy` passes it
    // at rollout. An ENV here would take effect only when the deploy stopped
    // setting one, which is the confusing half of that bug.
    expect(await readFile(DOCKERFILE, 'utf8')).not.toMatch(/^ENV LANES_LINK_HOME=/m);
  });
});
