/**
 * What survives into the audit log when contacts are searched.
 *
 * The keys carry a `people.` prefix that no other Google provider here needs,
 * and it is not a typo. `shortenName` strips the *provider id* from an
 * operationId, and this provider is `contacts` while Google's operationIds all
 * say `people` — so nothing is stripped, and the capability really is called
 * `people.people.searchContacts`. A key written `people.searchContacts` would
 * match nothing, withhold every value, and look exactly like redaction working.
 *
 * `query` is withheld throughout. A name someone is looking up is content, and
 * it is the line `icloud_contacts.search_contacts` already draws. What is kept
 * is the shape of the request: how many were asked for, which fields, and — on
 * `getBatchGet` — the opaque resource names, which are identifiers rather than
 * anything a person wrote.
 */
export const CONTACTS_REDACT: Record<string, string[]> = {
  'people.people.searchContacts': ['pageSize', 'readMask'],
  'people.otherContacts.search': ['pageSize', 'readMask'],
  'people.people.getBatchGet': ['resourceNames', 'personFields'],
};
