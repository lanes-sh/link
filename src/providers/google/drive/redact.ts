/**
 * What survives into the audit log when a file is read or changed.
 *
 * Drive shipped without a redaction block, which meant `files.create` recorded
 * that a file had been made and nothing about which one. Three write operations
 * beside it make the gap worth closing rather than noting.
 *
 * `name` is withheld on `files.create` and `files.update` — the same call as
 * Gmail's `labels.create`, where the name is the user's own words. `q` is
 * withheld on `files.list` on the same ground Gmail withholds a search: the
 * query is a question someone asked, not a record of what happened. Everything
 * kept is an identifier or a flag: which file, which parents it moved between,
 * whether it went to the trash.
 *
 * `permissions.create` keeps `emailAddress` and `domain`, and that departs from
 * the withhold-addresses rule on purpose. Gmail withholds recipients because
 * they are part of a message the log already refuses to record. Here the
 * grantee *is* the change: an access log that can say a file was shared with
 * somebody as a writer, but not with whom, has failed at the single question it
 * exists to answer.
 */
export const DRIVE_REDACT: Record<string, string[]> = {
  'files.list': ['pageSize', 'orderBy', 'spaces', 'includeItemsFromAllDrives'],
  'files.get': ['fileId', 'acknowledgeAbuse'],
  'files.export': ['fileId', 'mimeType'],
  'permissions.list': ['fileId'],
  'files.create': ['mimeType', 'parents'],
  'files.update': ['fileId', 'addParents', 'removeParents', 'trashed', 'starred', 'mimeType'],
  'files.copy': ['fileId', 'parents'],
  'permissions.create': [
    'fileId',
    'role',
    'type',
    'domain',
    'emailAddress',
    'sendNotificationEmail',
    'transferOwnership',
  ],
};
