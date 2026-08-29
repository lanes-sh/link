/**
 * What a file is, from its name.
 *
 * Split out of `attachments.ts` when that file passed the size budget, and it is
 * the right seam rather than a convenient one: resolving a *source* into bytes
 * and deciding what those bytes *are* are separate questions, and only the
 * second one is a lookup table nobody needs to read.
 */

export function basename(path: string): string | null {
  const name = path.split(/[/\\]/).pop();
  return name ? decodeURIComponent(name) : null;
}

/**
 * Type from the filename, since three of the five sources do not report one.
 *
 * A table rather than `Bun.file().type`, which would resolve this in one line:
 * Bun-specific APIs are confined to two named files, and a mail composer is not
 * one of them. Deliberately short — what an attachment actually is, not a mime
 * database. Anything unlisted becomes `application/octet-stream`, which every
 * mail client handles as "a file", so the failure mode is a generic icon rather
 * than a broken attachment.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  ics: 'text/calendar',
  vcf: 'text/vcard',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  heic: 'image/heic',
  tiff: 'image/tiff',
  zip: 'application/zip',
  gz: 'application/gzip',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // `.pages`, `.numbers` and `.key` are absent on purpose. Their registered
  // media types carry a vendor name, and `architecture.test.ts` refuses one
  // anywhere a request passes through — correctly, even though an IANA type is
  // not the vendor *knowledge* that rule is aimed at. They fall through to
  // octet-stream, which mail clients show as a file and the recipient's system
  // opens by extension anyway. Adding them back will fail the suite.
};

/**
 * Exported because `assets` needs exactly this and the table above must not be
 * copied — its `.pages`/`.numbers` note is a rule the copy would not carry.
 */
export function guessContentType(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();
  return (extension ? CONTENT_TYPES[extension] : undefined) ?? 'application/octet-stream';
}
