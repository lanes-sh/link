/**
 * iCloud's four providers: three sharing one app-specific password, and Drive,
 * which shares nothing because Apple exposes no protocol for it at all.
 */
export { icloudCalendar } from './calendar/index.ts';
export { icloudContacts } from './contacts/index.ts';
export { icloudDrive } from './drive/index.ts';
export { icloudMail } from './mail/index.ts';
