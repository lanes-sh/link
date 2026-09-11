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

/**
 * The arguments an operation takes, as a vendor documents them.
 *
 * Present because the ranking reads them and a fixture where every capability
 * took the same `id` could not show whether that helps or hurts. They are also
 * what the byte budget is spent on, so a corpus without them measures an answer
 * size no real endpoint produces.
 */
type Args = Readonly<Record<string, string>>;

/** What a vendor gives an operation when it documents nothing in particular. */
const PLAIN: Args = { id: 'The identifier of the resource.' };

function tool(
  id: string,
  title: string,
  description: string,
  args: Args = PLAIN,
): [string, MergedCapability] {
  return [
    id,
    {
      reachable: new Map([['personal', [`${id.split('.')[0]}.acct1`]]]),
      capability: undefined,
      // Read off the name here, which is the one thing the endpoint itself may
      // not do. This stands in for what a connector assigned from a vendor's
      // request method, and writing sixty of them out by hand would be the same
      // answer with more chances to typo it.
      reads: /(^|[._])(list|get|search|history|retrieve|read|query|freebusy)/.test(
        id.split('.').slice(1).join('.'),
      ),
      discovered: {
        name: 'ignored',
        title,
        description,
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries(
            Object.entries(args).map(([name, description]) => [name, { type: 'string', description }]),
          ),
        },
      },
    } as unknown as MergedCapability,
  ];
}

/** One provider's capabilities, every description carrying the same tail. */
function provider(
  id: string,
  label: string,
  keywords: readonly string[],
  capabilities: readonly (readonly [string, string, string, Args?])[],
): [string, MergedCapability][] {
  return capabilities.map(([name, title, description, args]) =>
    tool(`${id}.${name}`, `${label}: ${title}`, withKeywords(description, keywords), args),
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
    [
      'users.messages.list',
      'list messages',
      "Lists the messages in the user's mailbox.",
      {
        userId: 'The user whose mailbox to list.',
        q: 'Only return messages matching the specified query.',
        labelIds: 'Only return messages with all of the specified label IDs.',
        maxResults: 'Maximum number of messages to return.',
        pageToken: 'Page token to retrieve a specific page of results.',
      },
    ],
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
    [
      'send_message',
      'send message',
      'Send a message, with attachments, or save it as a draft.',
      {
        to: 'Recipients.',
        cc: 'Carbon-copy recipients.',
        bcc: 'Blind carbon-copy recipients.',
        subject: 'The subject line.',
        body: 'The message body.',
        attachments: 'Files to attach, by asset name or inline content.',
        draft: 'Save as a draft instead of sending.',
      },
    ],
  ]),
  ...provider('forge', 'Forge', REPO, [
    ['get_latest_release', 'get latest release', 'Get the latest release in a repository.'],
    ['list_pull_requests', 'list pull requests', 'List pull requests in a repository.'],
    ['create_pull_request', 'create pull request', 'Create a new pull request.'],
    ['list_issues', 'list issues', 'List issues in a repository.'],
    ['get_issue', 'get issue', 'Get a single issue by number.'],
    ['list_commits', 'list commits', 'List commits on a branch.'],
    ['list_branches', 'list branches', 'List branches in a repository.'],
    ['create_issue', 'create issue', 'Create a new issue in a repository.'],
    ['add_issue_comment', 'add issue comment', 'Add a comment to an existing issue.'],
    ['list_releases', 'list releases', 'List the releases in a repository.'],
    ['get_file_contents', 'get file contents', 'Get the contents of a file or directory.'],
    ['search_code', 'search code', 'Search for code across repositories.'],
    ['list_workflow_runs', 'list workflow runs', 'List workflow runs for a repository.'],
  ]),
  ...provider('agenda', 'Agenda', MEET, [
    ['events.list', 'list events', 'Returns events on the specified agenda.'],
    ['events.get', 'get events', 'Returns an event based on its identifier.'],
    [
      'events.insert',
      'insert events',
      'Creates an event.',
      {
        calendarId: 'Calendar identifier.',
        summary: 'Title of the event.',
        start: 'The start time.',
        end: 'The end time.',
        attendees: 'The people invited.',
        location: 'Geographic location as free-form text.',
        conferenceData: 'Conferencing details for the event.',
      },
    ],
    ['events.delete', 'delete events', 'Deletes an event.'],
    ['calendars.list', 'list calendars', "Returns the calendars on the user's calendar list."],
    ['calendars.get', 'get calendars', 'Returns metadata for a calendar.'],
    ['events.patch', 'patch events', 'Updates an event. This method supports patch semantics.'],
    ['events.move', 'move events', 'Moves an event to another calendar.'],
    ['events.instances', 'list event instances', 'Returns instances of the specified recurring event.'],
    ['freebusy.query', 'query free/busy', 'Returns free/busy information for a set of calendars.'],
    ['acl.list', 'list acl', 'Returns the rules in the access control list for the calendar.'],
  ]),
  ...provider('filestore', 'Filestore', FILES, [
    ['files.list', 'list files', "Lists the user's files."],
    ['files.get', 'get files', "Gets a file's metadata or content by ID."],
    [
      'files.create',
      'create files',
      'Creates a new file.',
      {
        name: 'The name of the file.',
        mimeType: 'The MIME type of the file.',
        parents: 'The IDs of the parent folders.',
        content: 'The bytes to upload.',
      },
    ],
    ['permissions.list', 'list permissions', "Lists a file's or shared drive's permissions."],
    ['permissions.create', 'create permissions', 'Creates a permission for a file or shared drive.'],
    ['permissions.delete', 'delete permissions', 'Deletes a permission.'],
    ['files.copy', 'copy files', "Creates a copy of a file and applies any requested updates."],
    ['files.update', 'update files', "Updates a file's metadata, content, or both."],
    ['files.delete', 'delete files', "Permanently deletes a file owned by the user without moving it to the trash."],
    ['files.export', 'export files', 'Exports a document to the requested MIME type.'],
    ['files.emptyTrash', 'empty trash', "Permanently deletes all of the user's trashed files."],
    ['drives.list', 'list drives', "Lists the user's shared drives."],
    ['changes.list', 'list changes', 'Lists the changes for a user or shared drive.'],
    ['revisions.list', 'list revisions', "Lists a file's revisions."],
  ]),
  ...provider('checklist', 'Checklist', TODO, [
    ['tasks.list', 'list tasks', 'Returns all tasks in the specified task list.'],
    [
      'tasks.insert',
      'insert tasks',
      'Creates a new task on the specified task list.',
      {
        tasklist: 'Task list identifier.',
        title: 'Title of the task.',
        due: 'Due date of the task.',
        notes: 'Notes describing the task.',
      },
    ],
    ['tasks.patch', 'patch tasks', 'Updates the specified task.'],
    ['tasklists.list', 'list tasklists', "Returns all the authenticated user's task lists."],
    ['tasks.get', 'get tasks', 'Returns the specified task.'],
    ['tasks.delete', 'delete tasks', 'Deletes the specified task from the task list.'],
    ['tasks.move', 'move tasks', 'Moves the specified task to another position in the task list.'],
    ['tasklists.insert', 'insert tasklists', 'Creates a new task list and adds it to the list.'],
  ]),
  ...provider('rolodex', 'Rolodex', WHO, [
    ['people.searchContacts', 'search contacts', "Provides a list of contacts matching the query."],
    ['people.get', 'get people', 'Provides information about a person.'],
    ['people.connections.list', 'list connections', "Provides a list of the authenticated user's rolodex."],
    ['people.createContact', 'create contact', 'Create a new contact and return the person resource.'],
    ['people.updateContact', 'update contact', 'Update contact data for an existing contact person.'],
    ['people.deleteContact', 'delete contact', 'Delete a contact person.'],
    ['otherContacts.list', 'list other contacts', 'List all other contacts, formerly known as "read-only contacts".'],
  ]),
  ...provider('chatter', 'Chatter', ['chat', 'channel', 'conversation', 'dm'], [
    ['chat.postMessage', 'post message', 'Sends a message to a channel.'],
    ['conversations.history', 'conversation history', "Fetches a conversation's history of messages and events."],
    ['conversations.list', 'list conversations', 'Lists all channels in a workspace.'],
    ['conversations.replies', 'conversation replies', "Retrieves a thread of messages posted to a conversation."],
    ['users.list', 'list users', 'Lists all users in a workspace.'],
    ['reactions.add', 'add reaction', 'Adds a reaction to an item.'],
    [
      'files.upload',
      'upload file',
      'Uploads or creates a file.',
      {
        channels: 'Comma-separated list of channel names or IDs where the file will be shared.',
        file: 'File contents.',
        filename: 'Filename of the file.',
        initial_comment: 'The message text introducing the file.',
      },
    ],
  ]),
  ...provider('tracker', 'Tracker', ['issue', 'ticket', 'project', 'backlog'], [
    ['list_issues', 'list issues', 'List issues in a team.'],
    ['create_issue', 'create issue', 'Create a new issue.'],
    ['get_issue', 'get issue', 'Get an issue by identifier.'],
    ['update_issue', 'update issue', 'Update an existing issue.'],
    ['list_projects', 'list projects', 'List projects in a workspace.'],
    ['list_teams', 'list teams', 'List teams in a workspace.'],
    ['create_comment', 'create comment', 'Add a comment to an issue.'],
    ['list_cycles', 'list cycles', 'List the cycles for a team.'],
  ]),
  ...provider('notebook', 'Notebook', ['page', 'note', 'wiki', 'database'], [
    ['search', 'search', 'Searches all pages and databases shared with the integration.'],
    ['pages.retrieve', 'retrieve pages', 'Retrieves a page object.'],
    ['blocks.children.list', 'list block children', 'Returns a paginated array of child block objects.'],
    ['databases.query', 'query database', 'Gets a list of pages contained in the database.'],
    ['pages.create', 'create page', 'Creates a new page in the specified database or as a child of a page.'],
    ['pages.update', 'update page', 'Updates the properties of a page in a database.'],
    ['blocks.children.append', 'append block children', 'Creates and appends new children blocks to the parent block.'],
    ['comments.list', 'list comments', 'Retrieves a list of un-resolved comment objects from a page or block.'],
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
  // A second calendar, and a second issue tracker.
  //
  // Two accounts in one domain is the case the endpoint exists for and the case
  // the ranking finds hardest: the vendors describe the same operation in
  // different words, so whichever wrote the sentence closer to the question wins
  // a slot its account did not earn. Mail already had this. Nothing else did,
  // and every calendar and issue query was therefore easier here than on a real
  // endpoint.
  ...provider('dayplan', 'Dayplan', MEET, [
    ['events.list', 'list events', 'Get a list of event objects in the specified calendar.'],
    ['events.create', 'create event', 'Create an event in the specified calendar.'],
    ['events.delete', 'delete event', 'Remove an event from the specified calendar.'],
    ['calendars.list', 'list calendars', "Get all the user's calendars."],
    [
      'findMeetingTimes',
      'find meeting times',
      'Suggest meeting times and locations based on organizer and attendee availability.',
    ],
    ['events.accept', 'accept event', 'Accept the specified event in a user calendar.'],
  ]),
  ...provider('ticketdesk', 'Ticketdesk', ['issue', 'ticket', 'sprint', 'board', 'bug', 'status', 'workflow', 'assignee'], [
    ['search_issues', 'search issues', 'Search for issues using a structured query language.'],
    ['get_issue', 'get issue', 'Returns the details for an issue.'],
    ['create_issue', 'create issue', 'Creates an issue or, where the option to create subtasks is enabled, a subtask.'],
    ['add_comment', 'add comment', 'Adds a comment to an issue.'],
    ['list_transitions', 'list transitions', 'Returns either all transitions or a transition that can be performed by the user on an issue.'],
    ['list_boards', 'list boards', 'Returns all boards. This only includes boards that the user has permission to view.'],
    ['list_sprints', 'list sprints', 'Returns all sprints from a board, for a given board ID.'],
  ]),
  // The long tail: providers nothing asks about, describing themselves in the
  // register an upstream MCP server actually uses. They are here to crowd, which
  // is most of what the 278 on a real endpoint do — and the reason a benchmark
  // over a corpus of only the providers being asked about reads high.
  ...provider('payflow', 'Payflow', ['payment', 'invoice', 'charge', 'refund', 'subscription', 'customer', 'billing', 'paid'], [
    ['charges.list', 'list charges', 'Returns a list of charges you have previously created.'],
    ['charges.create', 'create charge', 'To charge a credit card or other payment source, you create a Charge object.'],
    ['customers.list', 'list customers', 'Returns a list of your customers.'],
    ['customers.create', 'create customer', 'Creates a new customer object.'],
    ['invoices.list', 'list invoices', 'You can list all invoices, or list the invoices for a specific customer.'],
    ['invoices.send', 'send invoice', 'Invoices are sent to customers automatically according to your subscription settings.'],
    ['refunds.create', 'create refund', 'When you create a new refund, you must specify a Charge or a PaymentIntent object on which to create it.'],
    ['subscriptions.list', 'list subscriptions', 'By default, returns a list of subscriptions that have not been canceled.'],
  ]),
  ...provider('pulse', 'Pulse', ['analytics', 'event', 'funnel', 'cohort', 'dashboard', 'signup', 'conversion', 'retention', 'metric'], [
    ['events.query', 'query events', 'Query events with a set of filters and a time range.'],
    ['insights.get', 'get insight', 'Retrieve a single insight by its short id.'],
    ['cohorts.list', 'list cohorts', 'Return a paginated list of cohorts for the project.'],
    ['dashboards.list', 'list dashboards', 'Return a paginated list of dashboards for the project.'],
    ['persons.list', 'list persons', 'Return a paginated list of persons matching the supplied filters.'],
  ]),
  ...provider('sentinel', 'Sentinel', ['error', 'exception', 'trace', 'release', 'alert', 'bug', 'crash', 'stacktrace'], [
    ['issues.list', 'list issues', 'Return a list of issues bound to a project.'],
    ['issues.get', 'get issue', 'Return details on an individual issue.'],
    ['events.list', 'list events', 'Return a list of events bound to an issue.'],
    ['releases.list', 'list releases', 'Return a list of releases for a given organization.'],
    ['projects.list', 'list projects', 'Return a list of projects available to the authenticated session.'],
  ]),
  ...provider('deckhand', 'Deckhand', ['deploy', 'build', 'environment', 'log', 'domain', 'release', 'preview', 'failed'], [
    ['deployments.list', 'list deployments', 'List deployments under the authenticated user or team.'],
    ['deployments.get', 'get deployment', 'Retrieves information for a deployment by its unique identifier.'],
    ['projects.list', 'list projects', 'Allows to retrieve the list of projects of the authenticated user or team.'],
    ['logs.get', 'get logs', 'Get the build logs of a deployment by deployment ID and build ID.'],
    ['domains.list', 'list domains', 'Retrieves a list of domains registered for the authenticating user.'],
    ['env.list', 'list environment variables', 'Retrieve the environment variables for a given project.'],
  ]),
  ...provider('bookshelf', 'Bookshelf', ['content', 'entry', 'asset', 'locale', 'space', 'article', 'post', 'publish', 'draft'], [
    ['entries.list', 'list entries', 'Returns a collection of entries in a space.'],
    ['entries.get', 'get entry', 'Returns a single entry by its identifier.'],
    ['entries.create', 'create entry', 'Creates a new entry in the given space and content type.'],
    ['entries.publish', 'publish entry', 'Publishes an entry, making it available on the delivery API.'],
    ['assets.list', 'list assets', 'Returns a collection of assets in a space.'],
    ['contentTypes.list', 'list content types', 'Returns a collection of content types in a space.'],
  ]),

  // A provider nobody has heard of, whose vocabulary nothing else shares.
  ...provider('acme_crm', 'Acme CRM', ['customer', 'lead', 'deal', 'pipeline'], [
    ['leads.list', 'list leads', 'Return the leads in a pipeline stage.'],
    ['deals.get', 'get deal', 'Return a single deal by its reference.'],
  ]),
]);
