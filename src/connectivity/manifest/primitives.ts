import { z } from 'zod';

/** Provider ids, capability names, app names: lowercase, digits, underscores. */
export const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase letters, digits, and underscores');

/**
 * A pointer into the secret store, never a value.
 *
 * The pattern is what stops a manifest carrying the secret itself. A literal
 * API key has no `/` in it, so it fails here rather than being written to a
 * config file that someone later commits.
 */
export const credentialRef = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)+$/,
    'must be a credential reference like "bunq/api_key", not a literal value',
  );
