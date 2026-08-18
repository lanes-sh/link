/**
 * The three jobs `files.update` does that its name does not suggest.
 *
 * Drive spells "move", "rename", "trash", and "star" as one PATCH, and the
 * generated description is the vendor's field list. So an agent asked to move
 * or delete a file reads a tool list containing `files_update` and concludes
 * neither is possible — which is exactly what happened.
 */
export const DRIVE_HINTS: Record<string, string> = {
  'files.update': [
    'This is also how a file is moved, renamed, and deleted.',
    'Move it by passing `addParents` with the destination folder id and `removeParents`',
    'with the current one — a Drive file has no path, only parents.',
    'Rename it with `name`. Delete it with `trashed: true`, which is recoverable;',
    'there is deliberately no permanent-delete tool here, because Drive has a trash',
    'and an agent should not be able to bypass it. Restore with `trashed: false`.',
  ].join(' '),

  'files.create': [
    'This also creates the Google-native file types, which have no create tool of their own:',
    'pass `mimeType: "application/vnd.google-apps.spreadsheet"` for a spreadsheet,',
    '`.document` for a Doc, `.presentation` for Slides, or `.folder` for a folder,',
    'and leave the body empty. The file comes back with an id the Sheets and Docs tools',
    'then work on directly — creating a spreadsheet and filling it is this call followed by',
    '`sheets_spreadsheets_values_update`.',
    'Place it by passing `parents` with a folder id.',
  ].join(' '),
};
