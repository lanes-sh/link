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
  UPDATE_DraftPayment_for_User_MonetaryAccount: [
    'userID',
    'monetary-accountID',
    'itemId',
    'status',
    'entries',
    'previous_updated_timestamp',
    'number_of_required_accepts',
  ],
  CREATE_PaymentBatch_for_User_MonetaryAccount: ['userID', 'monetary-accountID', 'payments'],
};
