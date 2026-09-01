import { describe, expect, test } from 'bun:test';
import { planFor } from '#providers/setup/plan.ts';
import { setupRequirements } from '#connectivity';
import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { tokenInvocation } from './commands/operate/outputs.ts';

/**
 * Every `lanes link …` this build hands somebody to paste names both flags.
 *
 * These strings used to be correct by omission: a command without `--profile`
 * resolved to the workspace default, and one without `--target` to
 * `instance.default_target`, so most of them carried neither and worked anyway.
 * With nothing to fall back on (ADR-037) each one is a paste that refuses, and
 * `setup_provider` hands them to an agent, which pastes what it is given.
 *
 * Four templates, chosen because they are the ones reachable without a runtime,
 * a config file, or a credential store. A repo-wide grep would cover more and
 * would fail on every doc comment and every line of prose that happens to name
 * a command — brittle enough that it would be deleted the first time it cried
 * wolf.
 */

const WHERE = { profile: 'work', target: 'cloud' } as const;

describe('what setup tells someone to run', () => {
  test('every provider’s connect command names the profile and the target', () => {
    // Every manifest, not a sample: the failure is per provider, and the one
    // that gets missed is the one nobody wrote a test for.
    for (const manifest of PROVIDER_MANIFESTS) {
      const plan = planFor(manifest, { ...WHERE, connections: [] });

      expect(plan.command).toContain('--profile work');
      expect(plan.command).toContain('--workspace cloud');
    }
  });

  test('so does the --own-client variant, which is the same command plus a flag', () => {
    const brokered = PROVIDER_MANIFESTS.find(
      (manifest) => planFor(manifest, { ...WHERE, connections: [] }).ownClientCommand,
    );

    if (brokered) {
      const plan = planFor(brokered, { ...WHERE, connections: [] });
      expect(plan.ownClientCommand).toContain('--profile work');
      expect(plan.ownClientCommand).toContain('--workspace cloud');
    }
  });

  test('and the secrets set line for a value it needs first', () => {
    // The one that would be worst to get wrong: it writes a credential, so a
    // missing --workspace puts it in a store the endpoint asking for it does not
    // read, and reports success.
    const withPrompts = PROVIDER_MANIFESTS.filter(
      (manifest) => (manifest.setup?.prompts ?? []).length > 0,
    );

    expect(withPrompts.length).toBeGreaterThan(0);

    for (const manifest of withPrompts) {
      for (const requirement of setupRequirements(manifest, 'main', WHERE).requirements) {
        expect(requirement.command).toContain('--profile work');
        expect(requirement.command).toContain('--workspace cloud');
      }
    }
  });
});

describe('what outputs tells someone to run', () => {
  test('the token command names both, on whichever path it takes', async () => {
    const invocation = await tokenInvocation('a-token-no-endpoint-will-match', 'work', 'cloud');

    expect(invocation.command).toContain('--profile work');
    expect(invocation.command).toContain('--workspace cloud');
  });
});
