import { z } from 'zod';
import { identifier } from './primitives.ts';

/**
 * A named group of capabilities.
 *
 * For `http` connectors these are derived from the HTTP method — GET and HEAD
 * are `read`, mutating verbs are `write` — so a spec yields meaningful bundles
 * with no curation. A manifest may still declare its own.
 */
export const bundleSchema = z.object({
  name: identifier,
  description: z.string().default(''),
  oauth_scopes: z.array(z.string()).default([]),
  /** Glob patterns over capability names. Empty means "everything not matched by another bundle". */
  capabilities: z.array(z.string()).default([]),
  default: z.boolean().default(false),
});

export const READ_BUNDLE = 'read';
export const WRITE_BUNDLE = 'write';

export type ScopeBundle = z.infer<typeof bundleSchema>;
