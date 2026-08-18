/**
 * Custom providers — the ones an operator writes.
 *
 * A YAML manifest in `~/.lanes-link/providers/`, validated by exactly the schema
 * the built-ins are validated by, registered into exactly the same registry. A
 * service nobody has integrated is a file, not a pull request someone waits on.
 *
 * That equivalence is the scalability claim of the manifest design, and it is
 * only worth anything if it is literally true — so nothing here is a reduced
 * form of a built-in. `template.ts` scaffolds one starting point per
 * connectivity type; `load.ts` reads and validates them.
 */

export {
  WORKSPACE_PROVIDER_DIR,
  loadWorkspaceProviders,
  parseManifest,
  parseManifestFile,
  type LoadedManifest,
} from './load.ts';
export { manifestTemplate } from './template.ts';
