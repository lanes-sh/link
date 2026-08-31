import { layout } from '#profile';
import type { ProviderRegistry } from '#registry';
import { PROGRAM } from '../../usage.ts';

/**
 * What to say when a name resolves to no provider.
 *
 * The one message that has to teach something, because a misspelling and a
 * service nobody has integrated arrive here identically and want opposite
 * answers. So it prints both lists — what is shipped, and what this profile has
 * added — and then the command that adds another.
 *
 * It named `<root>/providers/` for a long time, which is not where manifests
 * live and never was. The path comes from `layout` now, like every other
 * profile-owned path, and the "add your own" line is printed whether or not the
 * operator already has one: showing it only to somebody with none meant hiding
 * it from everybody except the one person who could not yet know it existed.
 */
export function unknownProvider(input: {
  readonly providerId: string;
  readonly registry: ProviderRegistry;
  readonly workspaceRoot: string;
  readonly profile: string;
  readonly target: string;
}): Error {
  const available = input.registry.list();
  const builtin = available.filter((c) => c.origin === 'builtin').map((c) => c.manifest.id);
  const yours = available.filter((c) => c.origin === 'workspace').map((c) => c.manifest.id);

  const selection = `--profile ${input.profile} --target ${input.target}`;
  const directory = `${input.workspaceRoot}/${layout.providers()}`;

  return new Error(
    `Unknown provider "${input.providerId}".\n` +
      `  built in: ${builtin.join(', ')}\n` +
      (yours.length > 0 ? `  yours:    ${yours.join(', ')}\n` : '') +
      `  add your own: ${PROGRAM} connect custom ${input.providerId}` +
      ` --connector <kind> --auth <method> ${selection}\n` +
      `                or a manifest in ${directory}\n`,
  );
}
