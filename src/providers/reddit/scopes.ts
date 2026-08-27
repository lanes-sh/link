import type { ScopeMeaning } from '../scopes.ts';

/**
 * Reddit's scopes, in Reddit's own words.
 *
 * Taken verbatim from `https://www.reddit.com/api/v1/scopes`, which publishes a
 * description per scope, rather than paraphrased. A paraphrase is where a
 * consent screen quietly starts understating what it asks for, and the vendor's
 * own sentence is the one that can be checked against the vendor.
 *
 * Three are marked broad, and all three for the same reason: they act publicly
 * as the person. A post, a comment, a vote, and an edit are visible under their
 * username to everyone who reads the subreddit, and unlike a private write they
 * cannot be quietly undone — `delete` leaves the fact of the deletion behind,
 * and anything cached or quoted stays. `read` is not marked: it reaches only
 * what the account can already see, and Reddit's readable surface is public.
 */
export const REDDIT_SCOPE_MEANINGS: Record<string, ScopeMeaning> = {
  identity: { meaning: 'read your username and signup date' },
  read: { meaning: 'read posts and comments' },
  submit: { meaning: 'post and comment publicly as you', broad: true },
  edit: { meaning: 'edit and delete your posts and comments', broad: true },
  vote: { meaning: 'vote on posts and comments as you', broad: true },
  save: { meaning: 'save and unsave posts and comments' },
  flair: { meaning: 'set the flair on your posts' },
  mysubreddits: { meaning: 'list the subreddits you belong to' },
};
