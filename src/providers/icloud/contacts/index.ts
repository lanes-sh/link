import { defineProvider } from '#connectivity';
import { ICLOUD_APP, icloudSetup } from '../shared/setup.ts';

export const icloudContacts = defineProvider({
  id: 'icloud_contacts',
  name: 'iCloud Contacts',
  description: 'Search and read contacts in an iCloud address book over CardDAV.',
  connector: { kind: 'dav', base_url: 'https://contacts.icloud.com', service: 'carddav' },
  auth: { kind: 'basic', app: ICLOUD_APP },
  identity: { kind: 'connector' },
  setup: icloudSetup('iCloud Contacts'),
  redact: {
    // Not `query`: a name is content.
    search_contacts: ['addressbook', 'limit'],
    create_contact: ['addressbook'],
  },
});
