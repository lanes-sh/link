import { describe, expect, test } from 'bun:test';
import { createHttpConnector } from '#connectivity/transports';
import { bunq } from '../index.ts';

/**
 * What the vendored spec and the manifest have to keep agreeing about.
 *
 * `cli/tools.test.ts` checks these in one direction for every HTTP provider:
 * a redact key must name an argument that exists, a hint must name a capability
 * that exists. The other direction is the one that matters here, and only here.
 *
 * If an operation loses its redact entry — a bunq rename, a refresh that
 * changes a generated name — dispatch falls back to `redactAllValues` and the
 * log records that a payment happened without recording its amount or its
 * recipient. That is precisely the erasure `../redact.ts` exists to prevent, it
 * is silent, and no existing test looks for it. Scoped to bunq deliberately:
 * for a mailbox, withholding everything is the *right* default, so this is a
 * property of the provider that moves money rather than of HTTP providers.
 */

const manifest = bunq.manifest;
const connector = manifest.connector as { base_url: string; openapi: string };

const discovered = await createHttpConnector({
  baseUrl: connector.base_url,
  openapi: connector.openapi,
}).discover({ manifest });

/** The two that spend with no human step anywhere. */
const EXECUTES_IMMEDIATELY = [
  'CREATE_Payment_for_User_MonetaryAccount',
  'CREATE_PaymentBatch_for_User_MonetaryAccount',
];

describe('the vendored spec and the manifest agree', () => {
  test('the eleven operations are all there, and nothing else is', () => {
    expect(discovered.map((capability) => capability.name).sort()).toEqual([
      'CREATE_DraftPayment_for_User_MonetaryAccount',
      'CREATE_PaymentBatch_for_User_MonetaryAccount',
      'CREATE_Payment_for_User_MonetaryAccount',
      'List_all_DraftPayment_for_User_MonetaryAccount',
      'List_all_MonetaryAccount_for_User',
      'List_all_PaymentBatch_for_User_MonetaryAccount',
      'List_all_Payment_for_User_MonetaryAccount',
      'List_all_User',
      'READ_DraftPayment_for_User_MonetaryAccount',
      'READ_Payment_for_User_MonetaryAccount',
      'UPDATE_DraftPayment_for_User_MonetaryAccount',
    ]);
  });

  test('every capability is redacted deliberately, rather than by default', () => {
    // The default withholds every value. For a payment that is not caution, it
    // is an audit record with the two facts anybody would ever want removed.
    const undeclared = discovered
      .filter((capability) => !manifest.redact?.[capability.name])
      .map((capability) => capability.name);

    expect(undeclared).toEqual([]);
  });

  test('a write keeps the amount and the counterparty, which is the whole point', () => {
    const kept = manifest.redact?.['CREATE_Payment_for_User_MonetaryAccount'] ?? [];

    expect(kept).toContain('amount');
    expect(kept).toContain('counterparty_alias');
    expect(kept).toContain('monetary-accountID');
  });

  test('the tools that spend say so in their description', () => {
    // A generated description says what the arguments are. That a call moves
    // money and cannot be undone is not in bunq's document and has to be added,
    // and it is the single most important sentence this provider serves.
    for (const name of EXECUTES_IMMEDIATELY) {
      const capability = discovered.find((entry) => entry.name === name)!;
      expect(capability.description).toMatch(/executes immediately|Executes immediately/);
    }
  });

  test('no protocol header is offered as an argument', () => {
    // `X-Bunq-Client-Authentication` is the session token. It reaching a tool
    // schema would invite a model to fill it in, and make a tool call able to
    // carry a credential the strategy owns.
    const leaked = discovered.flatMap((capability) => {
      const properties = (capability.inputSchema?.['properties'] ?? {}) as Record<string, unknown>;
      return Object.keys(properties)
        .filter((name) => /^(x-bunq-|cache-control$|user-agent$)/i.test(name))
        .map((name) => `${capability.name}.${name}`);
    });

    expect(leaked).toEqual([]);
  });

  test('the tool that accepts a draft can be called correctly', () => {
    // Not a missing capability — a present one that could not be used. bunq
    // describes its update with the schema of its create, whose `required`
    // names `entries` and `number_of_required_accepts`, and then refuses both
    // here as superfluous. Every accept and every reject failed, and the two
    // bodies a model can reach for when a schema demands entries on a draft
    // that already has them — the array echoed back, or `[]` — both ask bunq to
    // rewrite what the draft pays on the way to approving it.
    //
    // Nothing else looked. `redact` and `hints` are checked against the tools
    // and the tools against the spec, but no test asked whether a schema
    // describes a call the vendor would accept.
    const update = discovered.find(
      (entry) => entry.name === 'UPDATE_DraftPayment_for_User_MonetaryAccount',
    )!;
    const properties = Object.keys((update.inputSchema?.['properties'] ?? {}) as object);

    expect(((update.inputSchema?.['required'] ?? []) as string[]).sort()).toEqual([
      'itemId',
      'monetary-accountID',
      'previous_updated_timestamp',
      'status',
      'userID',
    ]);
    expect(properties).not.toContain('entries');
    expect(properties).not.toContain('number_of_required_accepts');
    // `schedule` is the exclusion argued on risk rather than on the call
    // failing, so it is the one a revert would restore quietly: bunq accepts it
    // here, and it would come back as an *optional* property that the assertion
    // on `required` above cannot see.
    expect(properties).not.toContain('schedule');
  });

  test('creating a draft still asks for the payment it is a draft of', () => {
    // The other half of the same fix: the narrowing is keyed by operation, and
    // aimed at the wrong one it would leave a tool with no way to say what to
    // pay — which fails in the same silent shape, one call later.
    const create = discovered.find(
      (entry) => entry.name === 'CREATE_DraftPayment_for_User_MonetaryAccount',
    )!;
    const required = (create.inputSchema?.['required'] ?? []) as string[];

    expect(required).toContain('entries');
    expect(required).toContain('number_of_required_accepts');
  });

  test('the committed spec carries no component the paths do not use', () => {
    // Including, before this was filtered, a definition of the session header.
    const spec = require(connector.openapi) as { components: Record<string, unknown> };

    expect(Object.keys(spec.components)).toEqual(['schemas']);
  });
});
