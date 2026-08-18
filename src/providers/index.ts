import type { ProviderDefinition, ProviderManifest } from '#connectivity';
import { calendar } from './google/calendar/index.ts';
import { contacts } from './google/contacts/index.ts';
import { docs } from './google/docs/index.ts';
import { drive } from './google/drive/index.ts';
import { driveMcp } from './google/drive-mcp/index.ts';
import { gmail } from './google/gmail/index.ts';
import { gmailMcp } from './google/gmail-mcp/index.ts';
import { sheets } from './google/sheets/index.ts';
import { tasks } from './google/tasks/index.ts';
import { icloudCalendar } from './icloud/calendar/index.ts';
import { icloudContacts } from './icloud/contacts/index.ts';
import { icloudDrive } from './icloud/drive/index.ts';
import { icloudMail } from './icloud/mail/index.ts';
import { linear } from './linear/index.ts';
import { notion } from './notion/index.ts';

/**
 * Every provider, in one list.
 *
 * Names and imports only. There is no vendor knowledge in this file and there
 * must never be any — a Google scope, an Apple error message, or a spec path
 * appearing here means it has escaped the folder that owns it.
 *
 * Each folder holds *all* of its provider: the manifest, the scopes it asks
 * for, what it redacts from the audit log, the setup walkthrough, and any
 * vendored specification. Adding a provider is a folder and a line below.
 *
 * The list is a convenience, not a boundary: anything not here is a YAML
 * manifest in `~/.lanes-link/providers/`, validated by the same schema and
 * loaded by `./custom/load.ts`.
 *
 * The owner layer — `memory/`, `skills/`, `vault/` — is deliberately absent
 * from this list and not from this directory. Those three are providers in
 * every sense the architecture cares about, but they are *constructed* rather
 * than declared: each needs a store handed to it at startup, so they are
 * registered by `#profile`'s registry builder instead of being static data.
 */
/**
 * Manifests, and the rare provider that carries a capability of its own.
 *
 * The union is not an invitation. A provider is a *declaration*, and that is what
 * makes adding one cheap; `gmail` is a definition only because sending mail means
 * assembling a MIME message and no document describes doing that. Everything else
 * here is still fifteen lines of data. `registry.register` already accepted both
 * shapes, so nothing downstream had to change.
 */
export const PROVIDERS: readonly (ProviderManifest | ProviderDefinition)[] = [
  notion,
  linear,
  gmail,
  drive,
  sheets,
  docs,
  calendar,
  tasks,
  contacts,
  gmailMcp,
  driveMcp,
  icloudMail,
  icloudCalendar,
  icloudContacts,
  icloudDrive,
];

/** The manifest half of an entry, whichever shape it arrived in. */
export const manifestOf = (entry: ProviderManifest | ProviderDefinition): ProviderManifest =>
  'manifest' in entry ? entry.manifest : entry;

/**
 * Every provider's manifest, for the callers that only ask about declarations —
 * which scopes are requested, which are `http`, what `base_url` each names.
 *
 * Derived rather than a second list, so it cannot fall out of step with the one
 * above.
 */
export const PROVIDER_MANIFESTS: readonly ProviderManifest[] = PROVIDERS.map(manifestOf);

export {
  calendar,
  contacts,
  docs,
  drive,
  driveMcp,
  gmail,
  gmailMcp,
  sheets,
  tasks,
} from './google/index.ts';
export { icloudCalendar, icloudContacts, icloudDrive, icloudMail } from './icloud/index.ts';
export { linear } from './linear/index.ts';
export { notion } from './notion/index.ts';
export { SCOPE_MEANINGS, type ScopeMeaning } from './scopes.ts';
