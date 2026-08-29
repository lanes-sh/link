/**
 * Microsoft's five providers, sharing one Entra app registration.
 *
 * One API behind all of them, so unlike Google there is one client and one
 * consent screen shape — but the tokens still land per provider, so connecting
 * Outlook mail does not grant OneDrive.
 */
export { microsoftTodo } from './todo/index.ts';
export { onedrive } from './drive/index.ts';
export { outlookCalendar } from './calendar/index.ts';
export { outlookContacts } from './contacts/index.ts';
export { outlookMail } from './mail/index.ts';
