/**
 * A payment log that can answer "what moved, and to whom".
 *
 * The default is wrong here, and actively so. It withholds every value, which
 * for mail is the right instinct — the body is the private part — and for a
 * bank produces an audit log recording that a payment happened without
 * recording its amount or its recipient. That is not a redaction, it is an
 * erasure of the only facts anyone would ever go looking for.
 *
 * So the judgement runs the other way round from every other provider here: a
 * payment argument is a *fact about a transaction*, not a piece of the user's
 * content, and every one of them is kept. There is no equivalent of a message
 * body in this provider's write surface — the nearest thing is `description`,
 * which is the reference that appears on the recipient's statement and is
 * therefore already shared with a third party.
 *
 * The reads are listed for the same reason Sheets lists its own: they carry
 * identifiers and a page size, no query, and nothing worth protecting. Leaving
 * them out would mean a log that cannot distinguish reading one payment from
 * enumerating the account.
 *
 * Names are the generated argument names, which the OpenAPI generator prefixes
 * where a body field and a path parameter would otherwise collide.
 */
export const BUNQ_REDACT: Record<string, string[]> = {
  // Reads.
  List_all_User: [],
  List_all_MonetaryAccount_for_User: ['userID'],
  List_all_Payment_for_User_MonetaryAccount: ['userID', 'monetary-accountID'],
  READ_Payment_for_User_MonetaryAccount: ['userID', 'monetary-accountID', 'itemId'],
  List_all_DraftPayment_for_User_MonetaryAccount: ['userID', 'monetary-accountID'],
  READ_DraftPayment_for_User_MonetaryAccount: ['userID', 'monetary-accountID', 'itemId'],
  List_all_PaymentBatch_for_User_MonetaryAccount: ['userID', 'monetary-accountID'],

  // Writes. Everything, because everything is a fact worth reconstructing: the
  // account it left, the amount, who received it, and what the reference said.
  CREATE_Payment_for_User_MonetaryAccount: [
    'userID',
    'monetary-accountID',
    'amount',
    'counterparty_alias',
    'description',
    'merchant_reference',
    'allow_bunqto',
  ],
  CREATE_DraftPayment_for_User_MonetaryAccount: [
    'userID',
    'monetary-accountID',
    'entries',
    'number_of_required_accepts',
    'status',
    'schedule',
  ],
  // Five, not seven: `entries` and `number_of_required_accepts` are no longer
  // arguments at all. This is the one write here whose event cannot name an
  // amount or a counterparty, because the call does not carry them — it says
  // which draft was accepted and against which version of it, and that is
  // everything there is to keep.
  //
  // Not everything a reader wants, though, and worth being honest that the gap
  // is real rather than closed. The entries are on the event that *created* the
  // draft, and nothing joins the two: an `AuditEvent` records arguments only,
  // and bunq returns the draft id in the create's response. Reconstructing what
  // an ACCEPTED draft paid means matching by hand. `context.audit.annotate`,
  // which `gmail.send_message` uses to record resolved facts, is the shape of a
  // fix and is a change to dispatch rather than to this list.
  UPDATE_DraftPayment_for_User_MonetaryAccount: [
    'userID',
    'monetary-accountID',
    'itemId',
    'status',
    'previous_updated_timestamp',
  ],
  CREATE_PaymentBatch_for_User_MonetaryAccount: ['userID', 'monetary-accountID', 'payments'],
};
