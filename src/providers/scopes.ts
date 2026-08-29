import { GOOGLE_SCOPE_MEANINGS } from './google/shared/scopes.ts';
import { LINEAR_SCOPE_MEANINGS } from './linear/scopes.ts';
import { MICROSOFT_SCOPE_MEANINGS } from './microsoft/shared/scopes.ts';
import { REDDIT_SCOPE_MEANINGS } from './reddit/scopes.ts';
import { SLACK_SCOPE_MEANINGS } from './slack/scopes.ts';

/**
 * What a scope actually permits, contributed by the provider that requests it.
 *
 * Least privilege is the goal, and a vendor's *advertised* scope list is not the
 * same as its required one. Where a grant does have to be broad it must not
 * happen quietly: an over-broad grant is invisible after the fact, and a consent
 * screen listing five Google-worded scopes is not where someone discovers that
 * "Gmail" meant permanent delete.
 *
 * The table is here rather than in the CLI so that a provider owns its own
 * vocabulary. The CLI renders it and never learns a vendor's words.
 */
export interface ScopeMeaning {
  /** Plain-English meaning. */
  readonly meaning: string;
  /** Unrestricted access to the service, or close enough to warrant a stop. */
  readonly broad?: boolean;
}

export const SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  ...GOOGLE_SCOPE_MEANINGS,
  ...LINEAR_SCOPE_MEANINGS,
  ...MICROSOFT_SCOPE_MEANINGS,
  ...REDDIT_SCOPE_MEANINGS,
  ...SLACK_SCOPE_MEANINGS,
};
