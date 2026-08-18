import { defineProvider } from '#connectivity';
import { GOOGLE_APP, GOOGLE_OAUTH, PEOPLE_IDENTITY, specPath } from '../shared/oauth.ts';
import { googleSetup } from '../shared/setup.ts';
import { CONTACTS_REDACT } from './redact.ts';

/**
 * Read-only, so that "email Bob" resolves to an address.
 *
 * Two scopes, because Google keeps contacts in two places.
 * `contacts.readonly` is the address book someone curated;
 * `contacts.other.readonly` is where Gmail files an address written to but
 * never saved, which is where most of the Bobs actually are. Asking for only
 * the first would answer confidently and wrongly for the common case.
 *
 * Both are read-only, so neither is marked broad. The write scope is
 * `contacts`, it permanently deletes, and it is not requested — nothing here
 * writes. A contact card is the shape where a round trip silently destroys
 * data, which is the same reason `icloud_contacts` declines to edit one.
 *
 * The provider is `contacts` while Google's API is People. That mismatch is
 * load-bearing in `redact.ts` — see the note there — and it is deliberate: the
 * thing an operator connects is their contacts, and `icloud_contacts` is
 * already the neighbour in the list.
 */
const CONTACTS_SCOPES = [
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/contacts.other.readonly',
];

export const contacts = defineProvider({
  id: 'contacts',
  name: 'Google Contacts',
  description:
    'Look up a saved contact by name to find their address or phone number, including the addresses Gmail saved automatically. Read-only, via the People REST API.',
  connector: {
    kind: 'http',
    base_url: 'https://people.googleapis.com',
    openapi: specPath('people.v1.json'),
  },
  auth: {
    kind: 'oauth',
    registration: 'manual',
    app: GOOGLE_APP,
    scopes: CONTACTS_SCOPES,
    ...GOOGLE_OAUTH,
  },
  identity: PEOPLE_IDENTITY,
  setup: googleSetup('Contacts', CONTACTS_SCOPES, { apis: ['people.googleapis.com'] }),
  redact: CONTACTS_REDACT,
});
