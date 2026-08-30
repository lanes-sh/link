import { defineProvider } from '#connectivity';
import { FASTMAIL_APP, fastmailSetup } from '../shared/setup.ts';

export const fastmailContacts = defineProvider({
  id: 'fastmail_contacts',
  name: 'Fastmail Contacts',
  description: 'Search and read contacts in a Fastmail address book over CardDAV.',
  connector: { kind: 'dav', base_url: 'https://carddav.fastmail.com', service: 'carddav' },
  auth: { kind: 'basic', app: FASTMAIL_APP },
  identity: { kind: 'connector' },
  setup: fastmailSetup('Fastmail Contacts'),
  redact: {
    // Not `query`: a name is content.
    search_contacts: ['addressbook', 'limit'],
    create_contact: ['addressbook'],
  },
});
