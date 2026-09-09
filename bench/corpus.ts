/**
 * Turn the harvest into the fixture the benchmark reads.
 *
 * Two things happen here and both are required rather than tidy. Provider ids
 * and every vendor's name in its own prose are replaced, because
 * `architecture.test.ts` refuses a vendor name in `server/` and because a
 * fixture that names the vendor lets a ranker match the vendor instead of the
 * capability. And anything shaped like an address is replaced, because a
 * vendored spec documents its search syntax with one and this repository is
 * public.
 *
 * The *shape* is kept exactly: the operation ids, the vendor's own register,
 * the crowding of two mail providers and three task surfaces, and the
 * provider keywords appended identically to every one of a provider's
 * capabilities.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const ALIAS: Record<string, [string, string]> = {
  gmail: ['postbox', 'Postbox'],
  outlook_mail: ['mailhub', 'Mailhub'],
  drive: ['filestore', 'Filestore'],
  onedrive: ['cabinet', 'Cabinet'],
  calendar: ['agenda', 'Agenda'],
  outlook_calendar: ['daybook', 'Daybook'],
  google_tasks: ['checklist', 'Checklist'],
  microsoft_todo: ['taskpad', 'Taskpad'],
  contacts: ['rolodex', 'Rolodex'],
  outlook_contacts: ['cardfile', 'Cardfile'],
  sheets: ['gridwork', 'Gridwork'],
  docs: ['scribe', 'Scribe'],
  discord: ['chatter', 'Chatter'],
  reddit: ['forumly', 'Forumly'],
  bunq: ['ledger', 'Ledger'],
  lanes_memory: ['lanes_memory', 'Memory'],
  lanes_tasks: ['lanes_tasks', 'Tasks'],
  lanes_assets: ['lanes_assets', 'Assets'],
  lanes_entities: ['lanes_entities', 'Entities'],
};

/** Every spelling of a vendor that appears in its own documents. */
const NAMES: [RegExp, string][] = [
  [/\bGoogle Workspace\b/gi, 'the workspace'],
  [/\bGoogle Drive\b/gi, 'Filestore'],
  [/\bGoogle Calendar\b/gi, 'Agenda'],
  [/\bGoogle Sheets\b/gi, 'Gridwork'],
  [/\bGoogle Docs\b/gi, 'Scribe'],
  [/\bGoogle Tasks\b/gi, 'Checklist'],
  [/\bGmail\b/gi, 'Postbox'],
  [/\bGoogle\b/gi, 'the vendor'],
  [/\bMicrosoft Graph\b/gi, 'the API'],
  [/\bMicrosoft To ?Do\b/gi, 'Taskpad'],
  [/\bOutlook\b/gi, 'Mailhub'],
  [/\bOneDrive\b/gi, 'Cabinet'],
  [/\bSharePoint\b/gi, 'Cabinet'],
  [/\bMicrosoft\b/gi, 'the vendor'],
  [/\bEntra\b/gi, 'the directory'],
  [/\bDiscord\b/gi, 'Chatter'],
  [/\bReddit\b/gi, 'Forumly'],
  [/\bbunq\b/gi, 'Ledger'],
  [/\bApple\b/gi, 'the vendor'],
  [/\biCloud\b/gi, 'the vendor'],
];

function scrub(text: string, providerLabel: string): string {
  let out = text;
  for (const [pattern, replacement] of NAMES) out = out.replace(pattern, replacement);
  // Addresses, and the hosts they live at. A vendored spec teaches its search
  // syntax with a real one, and that is the leak CLAUDE.md is about.
  out = out.replace(/\bhttps?:\/\/[^\s)"']+/gi, 'https://example.test/docs');
  out = out.replace(/\b[a-z0-9-]+\.(?:com|org|net|io|dev|co\.uk|googleapis\.com)\b/gi, 'example.test');
  out = out.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, 'ada.lovelace@example.com');
  return out.replace(/\bthe vendor\b/g, providerLabel);
}

type Harvested = {
  provider: string;
  keywords: string[];
  providerDescription: string;
  name: string;
  title?: string;
  description: string;
  schemaBytes: number;
  properties: string[];
  required: string[];
};

const rows = JSON.parse(readFileSync(process.argv[2] as string, 'utf8')) as Harvested[];
const entries: Record<string, unknown>[] = [];

for (const row of rows) {
  const alias = ALIAS[row.provider];
  if (!alias) throw new Error(`no alias for ${row.provider}`);
  const [id, label] = alias;

  // Both already carry what the endpoint puts there: `discover` applies the
  // provider prefix to the title and appends the manifest's keywords to the
  // description. Adding either again would double it, which inflates every
  // capability's text with the half that is identical across the provider —
  // making the fixture easier than the surface in the one way that matters.
  entries.push({
    id: `${id}.${row.name}`,
    title: scrub(row.title ?? row.name.replace(/[._]/g, ' '), label),
    description: scrub(row.description, label),
    properties: row.properties.slice(0, 12),
    required: row.required,
    schemaBytes: row.schemaBytes,
  });
}

const queries = JSON.parse(readFileSync(process.argv[3] as string, 'utf8'));
writeFileSync(process.argv[4] as string, `${JSON.stringify({ entries, queries }, null, 1)}\n`);
console.error(`${entries.length} capabilities, ${queries.length} questions`);
