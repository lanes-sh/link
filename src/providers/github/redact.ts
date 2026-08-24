/**
 * What survives into the audit log when GitHub is written to.
 *
 * The default withholds every value, which is right for a server whose
 * capabilities we did not author and cannot know the shape of. It is wrong for
 * the writes: "an issue was edited" without saying which issue, in which
 * repository, or into what state is a record of nothing.
 *
 * The line drawn is the one Gmail and Drive draw. Identifiers and flags are
 * kept — `owner`, `repo`, the number, the method, the state, the labels and
 * reviewers, the merge method. The user's own words are withheld: `title`,
 * `body`, `commit_message`. A log that said which pull request was merged and
 * by what method has answered the question; one that also quoted the commit
 * message has started keeping a copy of the work.
 *
 * `assignees` and `reviewers` are kept, and that departs from withholding
 * people the way `drive.permissions.create` keeps `emailAddress`: assigning
 * somebody *is* the change, so a log that cannot say to whom has failed at its
 * one question.
 *
 * Two caveats worth stating rather than discovering.
 *
 * A proxied server's capabilities are discovered, not declared, so the argument
 * names below come from GitHub's published tool documentation rather than from
 * a schema in this repository. `cli/tools.test.ts` checks these names for every
 * `http` provider and cannot check them here — there is nothing local to check
 * against. A name that is wrong, or that GitHub renames later, fails the way
 * that test exists to prevent: silently, with the value withheld and the log
 * reading exactly as it does when redaction is working. `lanes link doctor`
 * reporting capability drift is the signal that this list wants re-reading.
 *
 * Reads are absent on purpose. `search_issues` takes a `query`, which is a
 * question somebody asked rather than a record of something that happened —
 * the same ground Gmail withholds `q` on.
 */
export const GITHUB_REDACT: Record<string, string[]> = {
  // `method` is the verb — create, update, close — and without it the entry
  // says an issue was written to and not what was done to it.
  issue_write: [
    'owner',
    'repo',
    'issue_number',
    'method',
    'state',
    'state_reason',
    'labels',
    'assignees',
    'milestone',
    'type',
    'duplicate_of',
  ],
  add_issue_comment: ['owner', 'repo', 'issue_number', 'comment_id', 'reaction'],
  sub_issue_write: [
    'owner',
    'repo',
    'issue_number',
    'method',
    'sub_issue_id',
    'replace_parent',
    'after_id',
    'before_id',
  ],
  // No `title`: a branch name says which change this is, and the title is the
  // author's summary of it.
  create_pull_request: [
    'owner',
    'repo',
    'head',
    'base',
    'draft',
    'reviewers',
    'maintainer_can_modify',
  ],
  update_pull_request: [
    'owner',
    'repo',
    'pullNumber',
    'base',
    'state',
    'draft',
    'reviewers',
    'maintainer_can_modify',
  ],
  merge_pull_request: ['owner', 'repo', 'pullNumber', 'merge_method'],
  // `event` is the one that matters: approving is a different act from
  // commenting, and this is the only place that distinction is recorded.
  pull_request_review_write: [
    'owner',
    'repo',
    'pullNumber',
    'method',
    'event',
    'commitID',
    'threadId',
  ],
  add_comment_to_pending_review: [
    'owner',
    'repo',
    'pullNumber',
    'path',
    'line',
    'startLine',
    'side',
    'startSide',
    'subjectType',
  ],
  add_reply_to_pull_request_comment: ['owner', 'repo', 'pullNumber', 'commentId', 'reaction'],
  update_pull_request_branch: ['owner', 'repo', 'pullNumber', 'expectedHeadSha'],
};
