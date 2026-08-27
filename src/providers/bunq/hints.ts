/**
 * What bunq's own descriptions leave out, and an agent has to know.
 *
 * Appended to the generated description at discovery. Three things earn a line
 * here: the distinction that decides whether money moves, the shape of an
 * amount, and the identifier an agent cannot guess.
 */
export const BUNQ_HINTS: Record<string, string> = {
  List_all_User:
    'Call this first. Every other bunq tool is addressed under a userID, and this is the only thing that reports it.',

  List_all_MonetaryAccount_for_User:
    'Returns every account: current, savings, joint, and closed ones. Each is wrapped in a type key ' +
    '(MonetaryAccountBank, MonetaryAccountSavings, …) and the id inside it is the `monetary-accountID` ' +
    'the payment tools take. Check `status` is ACTIVE before paying from one.',

  CREATE_Payment_for_User_MonetaryAccount:
    'This executes immediately and is not reversible. The money leaves the account as soon as bunq accepts the call — ' +
    'there is no confirmation step, in the app or anywhere else. Use draft-payment instead when a human should see it first. ' +
    'amount is { "value": "10.00", "currency": "EUR" } — a decimal string, not a number, and never cents. ' +
    'counterparty_alias is { "type": "IBAN", "value": "<iban>", "name": "<account holder>" }, and for IBAN the name must match ' +
    'the one on the receiving account. type may also be EMAIL or PHONE_NUMBER for another bunq user.',

  CREATE_DraftPayment_for_User_MonetaryAccount:
    'Prepares a payment without sending it: it waits in the bunq app until a human approves it, which is the checkpoint ' +
    'a direct payment does not have. Takes `entries`, an array of { amount, counterparty_alias, description } shaped exactly ' +
    'like a direct payment, plus number_of_required_accepts (1 for a personal account).',

  UPDATE_DraftPayment_for_User_MonetaryAccount:
    'Changes a draft that is still pending — status ACCEPTED sends it, REJECTED cancels it. ' +
    'previous_updated_timestamp is required and comes from reading the draft first; it is what stops two ' +
    'callers acting on the same draft. Those two fields are the entire call — bunq refuses entries and ' +
    'number_of_required_accepts here as superfluous — so changing what a draft pays means rejecting it and ' +
    'creating another.',

  CREATE_PaymentBatch_for_User_MonetaryAccount:
    'Up to 350 payments in one call. Executes immediately, like a direct payment, and is all-or-nothing: bunq rejects ' +
    'the whole batch if any entry is invalid. `payments` must be an ARRAY of { amount, counterparty_alias, description } ' +
    'objects, each shaped exactly like a direct payment — bunq\'s specification declares the field as an object rather ' +
    'than an array, which is wrong, so the schema here cannot tell you that and this line has to.',

  List_all_Payment_for_User_MonetaryAccount:
    'Newest first, one page at a time. bunq pages with `count`, `older_id` and `newer_id` rather than an offset, ' +
    'but its specification does not declare them, so this tool returns the most recent page and no more.',
};
