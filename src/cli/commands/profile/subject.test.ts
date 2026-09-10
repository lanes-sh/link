import { afterAll, describe, expect, test } from 'bun:test';
import type { Config, TargetConfig } from '#profile';
import { profileYaml, workspaceYaml, writeProfileFixture } from '#profile/testing.ts';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateProfile } from '../../runtime.ts';
import { declaredRefs, removalSubject, subjectOf, unreachableRefs } from './subject.ts';

/**
 * What a removal can read of a profile whose config will not load — #219.
 *
 * The property under test is not the wording of any field. It is that a field
 * this cannot read *shrinks* what a removal will delete and can never widen it:
 * `declaredRefs` derives from what the profile declares, and a declaration that
 * could not be read declares nothing. Everything else here supports that one.
 */

const roots: string[] = [];
const previousHome = process.env['LANES_LINK_HOME'];

/**
 * A profile the loader refuses, found the way `removeProfile` finds one.
 *
 * The directory is `my-profile` throughout, because that is the case #219
 * produces and because the name is *why* the document is refused: a hyphen is
 * outside `identifier`. So these fixtures are broken for the reason the issue's
 * are, rather than broken in a way invented for a test.
 */
async function located(body: string) {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-subject-'));
  roots.push(root);
  process.env['LANES_LINK_HOME'] = root;

  await writeFile(join(root, 'workspaces.yaml'), workspaceYaml(['local']));
  await writeProfileFixture(root, 'my-profile', body);

  return locateProfile({ profile: 'my-profile', target: 'local' });
}

afterAll(async () => {
  if (previousHome === undefined) delete process.env['LANES_LINK_HOME'];
  else process.env['LANES_LINK_HOME'] = previousHome;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const target = (over: Partial<TargetConfig> = {}): TargetConfig =>
  ({ credentials: { adapter: 'file' }, storage: { adapter: 'filesystem' }, ...over }) as unknown as TargetConfig;

const sealed = target({ vault: { adapter: 'secret' } } as never);

describe('removalSubject', () => {
  /**
   * The flagship case, and the reason there is one degraded path rather than
   * two. `profile add my-profile` wrote perfectly good YAML whose only fault is
   * a name the schema refuses — so everything a removal needs reads cleanly and
   * the plan is identical to a parsed one. A design that filed this under
   * "lesser removal" would owe the operator an explanation that is not true.
   */
  test('recovers every field from a document the schema refused', async () => {
    const subject = await removalSubject(await located(profileYaml('my-profile')));

    expect(subject.config).toBeNull();
    expect(subject.refusal).toContain('must be lowercase letters');
    expect([...subject.unread]).toEqual([]);
    expect(subject.name).toBe('my-profile');
    expect(subject.assumedName).toBe(false);
    expect(subject.vaultConnection).toBe('lan5');
  });

  test('a file that is not YAML yields nothing, and says so per field', async () => {
    const subject = await removalSubject(await located('contract: 5\ninstance:\n  profile: [\n'));

    expect([...subject.unread].sort()).toEqual(['auth', 'grants', 'knowledge', 'name']);
    // Still the directory's name, which is the one the operator typed.
    expect(subject.name).toBe('my-profile');
    expect(subject.assumedName).toBe(true);
  });

  test('a wrongly-shaped field is unread, not read as absent', async () => {
    // The distinction that matters: `grants: gmail` is not "no grants", it is
    // "this could not be read". Treating it as absence would let the removal
    // report certainty it does not have.
    const subject = await removalSubject(
      await located('contract: 5\ninstance:\n  profile: my-profile\ngrants: not-a-list\n'),
    );

    expect(subject.unread.has('grants')).toBe(true);
    expect(subject.vaultConnection).toBeNull();
  });

  test('an absent auth block is a complete read, not a gap', async () => {
    // Most profiles declare no `authorization`, so counting its absence as
    // unread would put "an OIDC client id, if this profile declared one" under
    // every degraded removal ever run.
    const subject = await removalSubject(
      await located('contract: 5\ninstance:\n  profile: my-profile\ngrants: []\n'),
    );

    expect(subject.unread.has('auth')).toBe(false);
    expect(subject.clientIdRef).toBeNull();
  });

  test('a name that disagrees with the directory is flagged, and the directory wins', async () => {
    // `layout.blobs(profile)` addresses the blob tree, so a hand-edited
    // `instance.profile` reaching it would let one profile's removal empty
    // another's directory.
    const subject = await removalSubject(await located(profileYaml('somebody-else')));

    expect(subject.name).toBe('my-profile');
    expect(subject.assumedName).toBe(true);
  });
});

describe('declaredRefs, from a subject that could not be read', () => {
  /**
   * The guarantee. Without it a degraded removal could queue a name that is not
   * this profile's, and in Secret Manager that deletion is not recoverable.
   */
  test('a subject with nothing read declares no ref at all', async () => {
    const subject = await removalSubject(await located('contract: 5\ninstance:\n  profile: [\n'));

    expect(declaredRefs(subject, sealed)).toEqual([]);
    expect(declaredRefs(subject, target())).toEqual([]);
  });

  test('and what it could not name is reported rather than passed over', async () => {
    const subject = await removalSubject(await located('contract: 5\ninstance:\n  profile: [\n'));
    const missing = unreachableRefs(subject, sealed, 'cloud');

    expect(missing.join('\n')).toContain('vault/my-profile/');
    expect(missing.join('\n')).toContain('OIDC client id');
  });

  test('a subject that read everything declares exactly what a parsed one does', async () => {
    // Parity, which is what makes the #219 case a full removal rather than a
    // partial one. The salvaged subject and the parsed subject must agree.
    const salvaged = await removalSubject(await located(profileYaml('my-profile')));
    const parsed = subjectOf({
      contract: 5,
      instance: { profile: 'my-profile' },
      auth: { mode: 'bearer' },
      grants: [{ connection: 'lanes_vault.lan5', allow: [], deny: [] }],
      members: [],
    } as unknown as Config);

    expect(declaredRefs(salvaged, sealed)).toEqual(declaredRefs(parsed, sealed));
    expect(unreachableRefs(salvaged, sealed, 'cloud')).toEqual([]);
  });

  test('a survivor keeps the ref it shares, even when the subject was salvaged', async () => {
    // The check that once made a sibling's sealed items unrecoverable. It has to
    // keep working on the degraded path, where the subject's ref was derived
    // rather than parsed.
    const salvaged = await removalSubject(await located(profileYaml('my-profile')));
    const survivor = subjectOf({
      contract: 5,
      instance: { profile: 'my-profile' },
      auth: { mode: 'bearer' },
      grants: [{ connection: 'lanes_vault.lan5', allow: [], deny: [] }],
      members: [],
    } as unknown as Config);

    expect(declaredRefs(salvaged, sealed, [survivor])).toEqual([]);
  });
});
