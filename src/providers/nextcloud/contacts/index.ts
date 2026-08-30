import { defineProvider } from '#connectivity';
import { NEXTCLOUD_APP, NEXTCLOUD_HOST, nextcloudSetup } from '../shared/setup.ts';

export const nextcloudContacts = defineProvider({
  id: 'nextcloud_contacts',
  name: 'Nextcloud Contacts',
  description: 'Search and read contacts in a Nextcloud address book over CardDAV, on your own server.',
  connector: { kind: 'dav', base_url: 'https://{host}', service: 'carddav' },
  auth: { kind: 'basic', app: NEXTCLOUD_APP },
  identity: { kind: 'connector' },
  variables: [NEXTCLOUD_HOST],
  setup: nextcloudSetup('Nextcloud Contacts'),
  redact: {
    // Not `query`: a name is content.
    search_contacts: ['addressbook', 'limit'],
    create_contact: ['addressbook'],
  },
});
