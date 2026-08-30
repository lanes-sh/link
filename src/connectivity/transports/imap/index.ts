import PostalMime from 'postal-mime';
import {
  type Connector,
  type DiscoveredCapability,
  type ToolResult,
} from '#connectivity';
import {
  createImapClient,
  quoted,
  type ImapClient,
  type ImapCredential,
  type ImapSession,
} from './client.ts';
import { asText, itemValue, type ImapToken } from './parser.ts';
import { decodeMailboxName, encodeMailboxName } from './utf7.ts';
import { sendOverSmtp, type Sender, type SmtpTarget } from './send.ts';
import type { SocketFactory } from './socket.ts';

/**
 * The `imap` connector — a mailbox, over the protocol every mail host speaks.
 *
 * Vendor-neutral by construction: iCloud, Fastmail, and a company Dovecot are
 * the same six manifest fields. There is no iCloud anywhere in this file, and
 * that is the test a new connector kind has to pass — protocol code, not vendor
 * code.
 *
 * Unlike `http`, there is nothing to read a capability list *from*: IMAP
 * describes its extensions through CAPABILITY but never its operations, so the
 * set below is fixed by RFC 3501 rather than by the vendor. `discover()` still
 * does real work — it logs in, so a wrong password fails at `connect` rather
 * than mid-task three days later, and it conditions the set on what the server
 * actually supports.
 *
 * **Reading never marks anything read.** Every read path uses `EXAMINE` rather
 * than `SELECT` and `BODY.PEEK[]` rather than `BODY[]`. Marking a message seen
 * is reachable only through `mark_messages`, which is in the write bundle —
 * never as an argument to a read capability, because an argument that flips a
 * capability's bundle defeats the split the policy is expressed in.
 *
 * **Nothing here can destroy mail.** No `EXPUNGE`, and `\Deleted` is not in the
 * flag allowlist. An agent that can permanently erase a mailbox is a different
 * risk class from one that can read it, and IMAP's delete is not recoverable
 * through this connector. If it is ever wanted, it is a third bundle.
 */

import { imapCapabilities } from './capabilities.ts';
import { mailboxAttachments } from './attachment.ts';
import { getAttachment } from './download.ts';
import { OPERATIONS } from './operations.ts';
import { error, json } from './result.ts';
import {
  getMessage,
  listMailboxes,
  markMessages,
  moveMessages,
  searchMessages,
  sendMessage,
} from './commands.ts';

export interface ImapConnectorOptions {
  /**
   * One line to append when the server refuses the credential, in the
   * provider's own words. See the identical field on `DavConnectorOptions`.
   */
  readonly troubleshooting?: string | undefined;
  readonly host: string;
  readonly port: number;
  readonly smtp?: SmtpTarget | undefined;
  readonly maxBodyBytes: number;
  readonly credential: () => Promise<ImapCredential>;
  /** Injected in tests, so no test needs a server. */
  readonly socket?: SocketFactory | undefined;
  readonly send?: Sender | undefined;
  readonly idleMs?: number | undefined;
}


export function createImapConnector(options: ImapConnectorOptions): Connector {
  const client: ImapClient = createImapClient({
    host: options.host,
    port: options.port,
    credential: options.credential,
    ...(options.socket ? { socket: options.socket } : {}),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.troubleshooting === undefined ? {} : { troubleshooting: options.troubleshooting }),
  });

  const send = options.send ?? sendOverSmtp;

  return {
    kind: 'imap',

    async discover(): Promise<DiscoveredCapability[]> {
      // Logging in is the point of discovering: a rejected app-specific
      // password should stop `connect`, not surface later as a failed tool call.
      const supportsMove = await client.run(async (session) => session.capabilities.has('MOVE'));

      return imapCapabilities({ supportsMove, canSend: options.smtp !== undefined });
    },

    async identify(): Promise<string | null> {
      // The account is the name the *server accepted*, which is a stronger claim
      // than the one the operator typed — a typo fails here rather than becoming
      // a permanent mislabel in config.
      return client.run(async (session) => session.username);
    },

    async invoke(capability, args, context): Promise<ToolResult> {
      const operation = String(capability.target?.['operation'] ?? capability.name);

      try {
        switch (operation) {
          case OPERATIONS.listMailboxes:
            return await client.run((session) => listMailboxes(session, args));
          case OPERATIONS.searchMessages:
            return await client.run((session) => searchMessages(session, args));
          case OPERATIONS.getMessage:
            return await client.run((session) => getMessage(session, args, options.maxBodyBytes));
          case OPERATIONS.getAttachment:
            // Handed the context for the same reason `send_message` is: what
            // came out is worth recording as resolved facts, and the raw
            // argument cannot say what the file turned out to be.
            return await getAttachment(
              mailboxAttachments(client),
              args as Record<string, unknown>,
              context.provider.audit,
              context.provider.storage,
              context.provider.connection,
            );
          case OPERATIONS.markMessages:
            // Never retried. A repeated flag change is harmless, but keeping the
            // rule uniform is what stops the exceptions from multiplying.
            return await client.run((session) => markMessages(session, args), { retry: false });
          case OPERATIONS.moveMessages:
            return await client.run((session) => moveMessages(session, args), { retry: false });
          case OPERATIONS.sendMessage:
            // The only operation handed the context: what it attached is worth
            // recording in a way `redact` cannot express, since the raw argument
            // may itself be a base64 file.
            return await sendMessage(
              client,
              options,
              send,
              args,
              context.provider.audit,
              context.provider.storage,
              context.provider.connection,
            );
          default:
            return error(`Unknown operation "${operation}".`);
        }
      } catch (failure) {
        // A protocol rejection is the server answering, not a fault of ours, so
        // it comes back as a tool error the agent can read — the same treatment
        // `http.ts` gives a non-2xx.
        return error((failure as Error).message);
      }
    },

    close: () => client.close(),
  };
}

// Re-exported for the tests that cover IMAP's two peculiar encodings directly.
export { imapDate, searchCriteria } from './parse.ts';
