/**
 * A stable id from something the owner typed, so writing does not demand one be
 * invented.
 *
 * Three owner-layer stores derive an id this way — a memory entry from its
 * title, a task from its title, an entity from its name — and they must derive
 * it *identically*, because the id is the filename and a person who has learned
 * what one store does with an apostrophe has learned what all three do.
 *
 * The 60-character cap is the whole of the length policy. It is not about any
 * filesystem limit: it is that an id appears in a policy rule, a resource URI
 * and an audit line, and a title-length one is unreadable in all three.
 *
 * `fallback` is the prefix for a name that slugifies to nothing — a title of
 * only punctuation, or of a script this transliterates away. Producing
 * `entry-14` rather than throwing is deliberate: the caller has content to
 * store, and refusing it because its title is CJK would be a worse answer than
 * an ugly id the owner can rename.
 */
export function slugify(text: string, fallback: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  return slug.length > 0 ? slug : `${fallback}-${text.length}`;
}
