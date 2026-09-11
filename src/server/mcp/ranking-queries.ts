/**
 * The questions, and the capability that answers each one.
 *
 * Beside the corpus rather than inside it because they are two subjects: one is
 * a surface to rank against, the other is what people ask of it. Adding a
 * question is the cheapest way to make the benchmark mean more, and it should
 * not mean opening the file that decides what there is to find.
 *
 * `top1` is the strict claim: this exact capability ranks first. A list means
 * several capabilities answer honestly and any of them ranking first is right,
 * which is a statement about the surface and not a loosened goalpost.
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
  // Two calendars are connected and neither query names one, so the same
  // reasoning the mail queries carry applies here: the operation is determined,
  // the account is not. Asserting `agenda` would assert a preference this
  // endpoint has no basis for. It reads as a loosened goalpost and is the
  // opposite — the corpus gained a second calendar, so the honest claim is
  // narrower than it was, not wider.
  { query: 'what meetings do i have', expect: ['agenda.events.list', 'dayplan.events.list'] },
  { query: 'schedule an appointment', expect: ['agenda.events.insert', 'dayplan.events.create'] },
  { query: 'find a document', expect: 'filestore.files.list' },
  { query: 'my todo list', expect: 'checklist.tasks.list' },
  { query: 'add a reminder', expect: 'checklist.tasks.insert' },
  { query: 'look up a contact', expect: 'rolodex.people.searchContacts' },
  { query: 'post to a channel', expect: 'chatter.chat.postMessage' },
  { query: 'search my notes', expect: 'notebook.search' },
  { query: 'leads in the pipeline', expect: 'acme_crm.leads.list' },

  // Questions about the rest of the surface.
  //
  // Sixteen questions put each one worth six points of the score, which is why
  // the number used to move in jumps and why a single fixable case looked like a
  // trend. These are written as questions first and checked afterwards: a set
  // chosen by which ones already passed would measure nothing except itself.
  { query: 'files shared with me', expect: 'filestore.files.list' },
  { query: 'who has access to this file', expect: 'filestore.permissions.list' },
  { query: 'make a copy of a document', expect: 'filestore.files.copy' },
  { query: 'delete a file permanently', expect: 'filestore.files.delete' },
  { query: 'am i free on thursday', expect: ['agenda.freebusy.query', 'dayplan.findMeetingTimes'] },
  { query: 'cancel a meeting', expect: ['agenda.events.delete', 'dayplan.events.delete'] },
  { query: 'reply in a thread', expect: 'chatter.conversations.replies' },
  { query: 'upload a file to a channel', expect: 'chatter.files.upload' },
  { query: 'bugs reported this week', expect: ['sentinel.issues.list', 'tracker.list_issues', 'ticketdesk.search_issues'] },
  { query: 'why did the build fail', expect: 'deckhand.logs.get' },
  { query: 'which version is deployed', expect: 'deckhand.deployments.list' },
  { query: 'refund a customer', expect: 'payflow.refunds.create' },
  { query: 'unpaid invoices', expect: 'payflow.invoices.list' },
  { query: 'how many signups last month', expect: 'pulse.events.query' },
  { query: 'publish a blog post', expect: 'bookshelf.entries.publish' },
  { query: 'move an issue to done', expect: ['ticketdesk.list_transitions', 'tracker.update_issue'] },
  { query: 'comment on a ticket', expect: ['ticketdesk.add_comment', 'tracker.create_comment'] },
  { query: 'what is in this pull request', expect: 'forge.list_pull_requests' },
  { query: 'save someone to my address book', expect: 'rolodex.people.createContact' },
  { query: 'a meeting with attendees and a location', expect: 'agenda.events.insert', note: 'reachable only through argument names' },
];
