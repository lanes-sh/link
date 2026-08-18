import type { Connector, ToolResult } from '#connectivity';
import { davCapabilities } from './capabilities.ts';
import { createContact, searchContacts } from './contacts.ts';
import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  updateEvent,
} from './calendar.ts';
import { DavClient } from './client.ts';
import { OPERATIONS } from './operations.ts';
import { error, validate } from './request.ts';

/**
 * The `dav` connector — CalDAV and CardDAV.
 *
 * One kind for both: they share the discovery dance and the `REPORT` machinery
 * and differ only in a namespace and a payload format. Vendor-neutral — iCloud,
 * Fastmail, Nextcloud and a Radicale on a Raspberry Pi are the same two manifest
 * fields.
 *
 * It is HTTPS, so `context.authorize` attaches Basic auth and this file never
 * sees a credential. That is the payoff for keeping auth orthogonal to
 * connectivity: a whole new protocol cost nothing on the credential side.
 *
 * **Where the account-specific routing lives.** Discovery resolves a *per
 * account* home URL — iCloud answers on a numbered partition host like
 * `p42-caldav.icloud.com` — and that must not go into
 * `DiscoveredCapability.target`, because the discovery cache is keyed by
 * provider rather than by connection. Two Apple accounts would share one entry,
 * and the second would be pointed at the first one's calendars. It goes in
 * per-connection state instead, which is already namespaced
 * `<provider>/<connection>` and lives in the state store, so a cold instance still serves
 * without re-discovering.
 *
 * The file itself is the wiring and nothing more: what is exposed is
 * `capabilities.ts`, how a request is made is `request.ts`, the session is
 * `client.ts`, and the operations are `calendar.ts` and `contacts.ts`.
 */

export interface DavConnectorOptions {
  readonly baseUrl: string;
  readonly service: 'caldav' | 'carddav';
  /**
   * Longest `list_events` window this server will answer, declared by the
   * provider. A server limit is the vendor's fact, not this transport's.
   */
  readonly maxRangeDays?: number | undefined;
  /**
   * One line to append when the server refuses the credential, in the
   * provider's own words. A transport can say "refused"; only the provider
   * knows why that usually happens for its vendor.
   */
  readonly troubleshooting?: string | undefined;
  /**
   * Used only to prove the credential works at `connect` time and to report
   * whose account it is. Every *operation* goes through `context.authorize`, so
   * this connector still has no idea where credentials are kept.
   */
  readonly credential?: (() => Promise<{ username: string; password: string }>) | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface Collection {
  readonly name: string;
  readonly href: string;
}

export function createDavConnector(options: DavConnectorOptions): Connector {
  const doFetch = options.fetch ?? globalThis.fetch;

  return {
    kind: 'dav',

    async discover() {
      const capabilities = davCapabilities(options.service);

      // Prove the credential before declaring the connection good. Without this
      // a wrong app-specific password surfaces as a failed tool call days later
      // rather than as a failed `connect` now.
      await validate(options, doFetch);

      return capabilities;
    },

    /**
     * Whose account this is: the name the *server accepted*.
     *
     * Same answer as `imap` gives, for the same reason — there is no endpoint
     * returning an email address, and the username is the identity. Returning it
     * only after a successful PROPFIND is what makes it a claim rather than an
     * echo of what was typed.
     */
    async identify(): Promise<string | null> {
      return validate(options, doFetch);
    },

    async invoke(capability, args, context): Promise<ToolResult> {
      const operation = String(capability.target?.['operation'] ?? capability.name);
      const dav = new DavClient(options, doFetch, context);

      try {
        switch (operation) {
          case OPERATIONS.listCalendars:
          case OPERATIONS.listAddressbooks:
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    options.service === 'caldav'
                      ? { calendars: await dav.collections() }
                      : { addressbooks: await dav.collections() },
                    null,
                    2,
                  ),
                },
              ],
            };
          case OPERATIONS.listEvents:
            return await listEvents(dav, args);
          case OPERATIONS.getEvent:
            return await getEvent(dav, args);
          case OPERATIONS.createEvent:
            return await createEvent(dav, args);
          case OPERATIONS.updateEvent:
            return await updateEvent(dav, args);
          case OPERATIONS.deleteEvent:
            return await deleteEvent(dav, args);
          case OPERATIONS.searchContacts:
            return await searchContacts(dav, args);
          case OPERATIONS.createContact:
            return await createContact(dav, args);
          default:
            return error(`Unknown operation "${operation}".`);
        }
      } catch (failure) {
        return error((failure as Error).message);
      }
    },
  };
}
