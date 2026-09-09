import type { MergedCapability } from './visibility.ts';

/**
 * A surface to rank against, and the questions people actually ask of it.
 *
 * The ranking had no way to fail visibly before this file. `search-index.test.ts`
 * asserts behaviours one at a time against four capabilities; a four-tool
 * surface cannot express the failure that prompted the work, because that
 * failure *is* crowding — twenty-seven matches, of which the five explained were
 * a release-notes tool and three draft tools.
 *
 * So this is a fixture built to be crowded, and the property it reproduces is
 * the one that matters: `withKeywords` appends a provider's vocabulary to
 * **every one of its capabilities, identically**. That is what makes `email` and
 * `inbox` match all eight A mail provider tools equally, leaving `localeCompare` to pick
 * the winner — and `drafts` sorts before `messages`.
 *
 * Kept beside the ranker rather than in a test file because two tests read it:
 * the accuracy assertion, and the benchmark that must not become a
 * timing-sensitive CI failure.
 */

/** The vocabulary a manifest declares, as `withKeywords` renders it. */
function withKeywords(description: string, keywords: readonly string[]): string {
  return `${description}\n\nAlso: ${keywords.join(', ')}.`;
}

function tool(id: string, title: string, description: string): [string, MergedCapability] {
  return [
    id,
    {
      reachable: new Map([['personal', [`${id.split('.')[0]}.acct1`]]]),
      capability: undefined,
      discovered: {
        name: 'ignored',
        title,
        description,
        inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      },
    } as unknown as MergedCapability,
  ];
}

/** One provider's capabilities, every description carrying the same tail. */
function provider(
  id: string,
  label: string,
  keywords: readonly string[],
  capabilities: readonly (readonly [string, string, string])[],
): [string, MergedCapability][] {
  return capabilities.map(([name, title, description]) =>
    tool(`${id}.${name}`, `${label}: ${title}`, withKeywords(description, keywords)),
  );
}

const MAIL = ['email', 'message', 'inbox', 'reply', 'correspondence'] as const;
const REPO = ['repository', 'code', 'pull request', 'issue', 'commit'] as const;
const MEET = ['meeting', 'appointment', 'schedule', 'invite', 'calendar'] as const;
const FILES = ['file', 'document', 'folder', 'attachment', 'upload'] as const;
const TODO = ['todo', 'task', 'reminder', 'checklist'] as const;
const WHO = ['contact', 'address book', 'person', 'people'] as const;

/**
 * Eleven providers, seventy-odd capabilities — the shape of a real endpoint
 * rather than a demonstration. Descriptions are the vendors' own register:
 * terse, in their own vocabulary, and never using the word a person would.
 */
export const CORPUS: Map<string, MergedCapability> = new Map([
  ...provider('postbox', 'Postbox', MAIL, [
    ['users.messages.list', 'list messages', "Lists the messages in the user's mailbox."],
    ['users.messages.get', 'get messages', 'Gets the specified message.'],
    [
      'users.messages.modify',
      'modify messages',
      'Modifies the labels on the specified message. This provider has no separate verb for read-state, ' +
        'archiving, or spam — each one is a label edit, and this is the operation that makes it. ' +
        'Archiving is removeLabelIds: ["INBOX"]; marking read is removeLabelIds: ["UNREAD"].',
    ],
    ['users.messages.trash', 'trash messages', 'Moves the specified message to the trash.'],
    ['users.drafts.list', 'list drafts', "Lists the drafts in the user's mailbox."],
    ['users.drafts.get', 'get drafts', 'Gets the specified draft.'],
    ['users.drafts.delete', 'delete drafts', 'Immediately and permanently deletes the specified draft.'],
    // The label operations are here in the number a real mail API has them,
    // and that number is the point. A fixture with one of them made this
    // provider's busiest noun *messages* by a wide margin, so the tiebreak that
    // reads frequency answered correctly for the wrong reason. A deployed
    // endpoint has five, which makes the two nouns level and puts the whole
    // weight of the answer back on the terms — which is where the ranking was
    // still getting it wrong.
    ['users.labels.list', 'list labels', "Lists all labels in the user's mailbox."],
    ['users.labels.create', 'create labels', 'Creates a new label.'],
    ['users.labels.delete', 'delete labels', 'Immediately and permanently deletes the specified label.'],
    ['users.labels.update', 'update labels', 'Updates the specified label.'],
    ['users.labels.patch', 'patch labels', 'Patch the specified label.'],
    ['users.threads.list', 'list threads', "Lists the threads in the user's mailbox."],
    ['send_message', 'send message', 'Send a message, with attachments, or save it as a draft.'],
  ]),
  ...provider('forge', 'Forge', REPO, [
    ['get_latest_release', 'get latest release', 'Get the latest release in a repository.'],
    ['list_pull_requests', 'list pull requests', 'List pull requests in a repository.'],
    ['create_pull_request', 'create pull request', 'Create a new pull request.'],
    ['list_issues', 'list issues', 'List issues in a repository.'],
    ['get_issue', 'get issue', 'Get a single issue by number.'],
    ['list_commits', 'list commits', 'List commits on a branch.'],
  ]),
  ...provider('agenda', 'Agenda', MEET, [
    ['events.list', 'list events', 'Returns events on the specified agenda.'],
    ['events.get', 'get events', 'Returns an event based on its identifier.'],
    ['events.insert', 'insert events', 'Creates an event.'],
    ['events.delete', 'delete events', 'Deletes an event.'],
    ['calendars.list', 'list calendars', "Returns the calendars on the user's calendar list."],
  ]),
  ...provider('filestore', 'Filestore', FILES, [
    ['files.list', 'list files', "Lists the user's files."],
    ['files.get', 'get files', "Gets a file's metadata or content by ID."],
    ['files.create', 'create files', 'Creates a new file.'],
    ['permissions.list', 'list permissions', "Lists a file's or shared drive's permissions."],
  ]),
  ...provider('checklist', 'Checklist', TODO, [
    ['tasks.list', 'list tasks', 'Returns all tasks in the specified task list.'],
    ['tasks.insert', 'insert tasks', 'Creates a new task on the specified task list.'],
    ['tasks.patch', 'patch tasks', 'Updates the specified task.'],
    ['tasklists.list', 'list tasklists', "Returns all the authenticated user's task lists."],
  ]),
  ...provider('rolodex', 'Rolodex', WHO, [
    ['people.searchContacts', 'search contacts', "Provides a list of contacts matching the query."],
    ['people.get', 'get people', 'Provides information about a person.'],
    ['people.connections.list', 'list connections', "Provides a list of the authenticated user's rolodex."],
  ]),
  ...provider('chatter', 'Chatter', ['chat', 'channel', 'conversation', 'dm'], [
    ['chat.postMessage', 'post message', 'Sends a message to a channel.'],
    ['conversations.history', 'conversation history', "Fetches a conversation's history of messages and events."],
    ['conversations.list', 'list conversations', 'Lists all channels in a workspace.'],
  ]),
  ...provider('tracker', 'Tracker', ['issue', 'ticket', 'project', 'backlog'], [
    ['list_issues', 'list issues', 'List issues in a team.'],
    ['create_issue', 'create issue', 'Create a new issue.'],
    ['get_issue', 'get issue', 'Get an issue by identifier.'],
  ]),
  ...provider('notebook', 'Notebook', ['page', 'note', 'wiki', 'database'], [
    ['search', 'search', 'Searches all pages and databases shared with the integration.'],
    ['pages.retrieve', 'retrieve pages', 'Retrieves a page object.'],
    ['blocks.children.list', 'list block children', 'Returns a paginated array of child block objects.'],
  ]),
  // An *authored* capability, whose description is written rather than generated
  // — so it says "mailbox", "most recent" and "reading" in those words, where a
  // vendored one says none of them. That asymmetry is what made a real endpoint
  // answer a two-account question with one account.
  ...provider('mailhub', 'Mailhub', MAIL, [
    ['listMessages', 'list messages', 'Get the messages in the signed-in user’s mailbox.'],
    ['getMessage', 'get message', 'Retrieve the properties and relationships of a message object.'],
    ['sendMail', 'send mail', 'Send the message specified in the request body.'],
    [
      'search_messages',
      'search messages',
      'Search a mailbox and return message summaries, most recent first. Reading does not mark anything as read.',
    ],
  ]),
  // A provider nobody has heard of, whose vocabulary nothing else shares.
  ...provider('acme_crm', 'Acme CRM', ['customer', 'lead', 'deal', 'pipeline'], [
    ['leads.list', 'list leads', 'Return the leads in a pipeline stage.'],
    ['deals.get', 'get deal', 'Return a single deal by its reference.'],
  ]),
]);

/**
 * What a person asks, and the capability that answers it.
 *
 * `top1` is the strict claim: this exact capability ranks first. Queries live
 * here rather than in the test so the benchmark can reuse them, and so adding a
 * case is a data change.
 */
export const QUERIES: readonly { query: string; expect: string | readonly string[]; note?: string }[] = [
  {
    query: 'latest email in inbox',
    // Three capabilities can honestly answer this and one of them is *better*
    // than the two list operations: an authored `search_messages` says it
    // returns summaries most recent first, which is the question. Accepting it
    // is not widening the goalposts — it is the right answer arriving.
    //
    // Two mail accounts are connected and the query names neither, so which
    // vendor answers is genuinely undetermined — the search returns both with
    // their accounts named, and the caller picks. What is *not* undetermined is
    // the operation: enumerating a mailbox, never fetching one message by an id
    // the caller does not have. Asserting the vendor here would be asserting a
    // preference the endpoint has no basis for.
    expect: ['mailhub.search_messages', 'postbox.users.messages.list', 'mailhub.listMessages'],
    note: 'the query that started this',
  },
  { query: 'last email received', expect: ['mailhub.search_messages', 'postbox.users.messages.list', 'mailhub.listMessages'] },
  { query: 'read my most recent mail', expect: ['mailhub.search_messages', 'postbox.users.messages.list', 'mailhub.listMessages'] },
  { query: 'send an email', expect: ['postbox.send_message', 'mailhub.sendMail'] },
  { query: 'archive a message', expect: 'postbox.users.messages.modify', note: 'reachable only through the hint text' },
  { query: 'latest release', expect: 'forge.get_latest_release', note: 'must survive the fix for "latest email"' },
  { query: 'open pull requests', expect: 'forge.list_pull_requests' },
  { query: 'what meetings do i have', expect: 'agenda.events.list' },
  { query: 'schedule an appointment', expect: 'agenda.events.insert' },
  { query: 'find a document', expect: 'filestore.files.list' },
  { query: 'my todo list', expect: 'checklist.tasks.list' },
  { query: 'add a reminder', expect: 'checklist.tasks.insert' },
  { query: 'look up a contact', expect: 'rolodex.people.searchContacts' },
  { query: 'post to a channel', expect: 'chatter.chat.postMessage' },
  { query: 'search my notes', expect: 'notebook.search' },
  { query: 'leads in the pipeline', expect: 'acme_crm.leads.list' },
];
