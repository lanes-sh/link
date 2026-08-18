import { z } from 'zod';
import { credentialRef } from './primitives.ts';

/**
 * What the CLI renders before asking for anything.
 *
 * The rest of the system stays domain-agnostic because it renders whatever a
 * provider declares. `docs` alone covers the common "here is where to generate
 * that key" case with no code at all.
 */

export const setupPromptSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  secret: z.boolean().default(false),
  /**
   * `shared` — one value for the whole profile, such as an OAuth client. It
   * needs an explicit ref, because nothing about a connection identifies it.
   *
   * `connection` — one value per account, so the ref *derives* and must not be
   * written: a manifest cannot name a connection that does not exist yet, and a
   * second copy of the answer could only ever disagree with the first.
   */
  scope: z.enum(['shared', 'connection']).default('shared'),
  /**
   * Which part of a composite credential this answers.
   *
   * `basic` needs two values in one credential and stores them as
   * `username:password` — RFC 7617's own encoding, so the store holds exactly
   * what the header carries and nothing has to agree about a JSON shape.
   */
  field: z.enum(['value', 'username', 'password']).default('value'),
  credential_ref: credentialRef.optional(),
});

export const setupSchema = z.object({
  summary: z.string().optional(),
  docs: z.string().optional(),
  docs_url: z.url().optional(),
  steps: z.array(z.string()).default([]),
  prompts: z.array(setupPromptSchema).default([]),
  /**
   * One line appended when authentication fails, in the provider's own words.
   *
   * A transport can say "the server refused the credential" and no more, because
   * it must not know which vendor it is talking to. The *provider* knows the
   * likely cause — for Apple it is nearly always an Account password used where
   * an app-specific password belongs — and that sentence is worth far more than
   * the status code. Declared here so the transport stays vendor-free.
   */
  troubleshooting: z.string().optional(),
});

export type SetupDeclaration = z.infer<typeof setupSchema>;
export type SetupPrompt = z.infer<typeof setupPromptSchema>;
