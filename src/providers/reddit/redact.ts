/**
 * What survives into the audit log when Reddit is written to.
 *
 * The line is Gmail's and Slack's, because it is the same object: something a
 * person wrote for other people to read. Where it went is recorded, what it
 * said is not. A log that quoted the body would be a second copy of everything
 * this account has ever posted, held somewhere nobody expects one.
 *
 * `title` is withheld along with the body, which is worth saying because it
 * looks like metadata and is not — a Reddit title is usually the whole of the
 * post, and the body is often empty. Keeping it would defeat the rest.
 *
 * Keys are the *shortened* names. `shortenName` strips a redundant provider
 * prefix, so these must match what the capability is finally called — keying
 * this block on anything else matches nothing and withholds everything,
 * silently and with the log still looking correct.
 */
export const REDDIT_REDACT: Record<string, string[]> = {
  // Everything that says where the post went and how it was marked, and nothing
  // that says what it said. `url` is withheld with the body: for kind="link"
  // the URL *is* the submission.
  submit_post: ['sr', 'kind', 'flair_id', 'nsfw', 'spoiler', 'sendreplies', 'api_type'],
  add_comment: ['thing_id', 'api_type'],
  edit_text: ['thing_id', 'api_type'],
  // Kept whole. Every argument is an identifier or a value from a fixed
  // vocabulary, and an entry recording that something was voted on without
  // recording which way records nothing anyone would look for — the reading
  // that lets Slack keep an emoji name.
  vote: ['id', 'dir'],
  delete_thing: ['id'],
  save_thing: ['id', 'category'],
  set_flair: ['sr', 'link', 'flair_template_id', 'api_type'],
};
