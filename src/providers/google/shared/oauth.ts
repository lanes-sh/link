/**
 * Google's OAuth endpoints, shared by every Google provider.
 *
 * A REST API announces nothing about where its authorization server lives, so
 * an `http` connector has to be told. `access_type=offline` and
 * `prompt=consent` are what make Google return a refresh token at all — without
 * them the connection works for an hour and then dies.
 */
export const GOOGLE_APP = 'google';

/**
 * The Google OAuth client Lanes operates, and where its secret stays.
 *
 * Its own Cloud project, separate from the one that signs people into Lanes:
 * this client asks for Gmail and Drive and carries a verification review that
 * can be rejected, and a rejection must not be able to take sign-in with it.
 *
 * The secret is not confidential in Google's sense — an installed app cannot
 * hold one — and is held back anyway. Shipping it would hand anyone the shared
 * quota and standing of a single client that every Lanes Link user depends on,
 * and there is no way to withdraw one copy of a secret.
 *
 * What this buys the operator is the whole of `setup/google.md`: no project, no
 * console, no scope list to transcribe, and no seven-day refresh-token expiry,
 * because that expiry is a property of a project left in "Testing" and this one
 * is not. What it costs is recorded in ADR-028 and in the guarantee table in
 * `docs/detailed/security.md` — chiefly that the exchange stops being local.
 */
export const GOOGLE_BROKER = {
  url: 'https://api.lanes.sh/v1/auth/link/google',
  operator: 'Lanes',
  docs_url: 'https://lanes.sh/link#google',
} as const;

export const GOOGLE_OAUTH = {
  authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth',
  token_url: 'https://oauth2.googleapis.com/token',
  //
  // `select_account` matters as much as the rest: with it omitted Google reuses
  // whichever account the browser is already signed into and never offers a
  // choice, so connecting a second mailbox silently re-authorises the first.
  authorize_params: { access_type: 'offline', prompt: 'select_account consent' },
  // Every REST provider here spreads this block, so one line turns brokering on
  // for all seven. `gmail_mcp` and `drive_mcp` write their auth longhand and do
  // not spread it, which is what keeps them bring-your-own — the SDK owns their
  // exchange and `defineProvider` refuses a broker on an mcp connector.
  broker: GOOGLE_BROKER,
} as const;

/**
 * Where a Google provider reads its account label from.
 *
 * Drive's endpoint, deliberately, for Sheets and Docs as well: neither has a
 * "who am I", and `drive.readonly` is requested anyway, so labelling the
 * connection costs no extra consent.
 */
export const DRIVE_IDENTITY = {
  kind: 'http',
  url: 'https://www.googleapis.com/drive/v3/about?fields=user',
  field: 'user.emailAddress',
} as const;

export const GMAIL_IDENTITY = {
  kind: 'http',
  url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile',
  field: 'emailAddress',
} as const;

/**
 * Calendar answers this itself, rather than borrowing Drive's endpoint.
 *
 * The entry for someone's own calendar is keyed by their address, so its `id`
 * *is* the label — and it reads under `calendar.readonly`, which this provider
 * requests anyway. Following Sheets and Docs to `DRIVE_IDENTITY` would mean
 * asking for `drive.readonly` purely to print a name.
 */
export const CALENDAR_IDENTITY = {
  kind: 'http',
  url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList/primary',
  field: 'id',
} as const;

/**
 * Contacts asks People who the token belongs to — using the very operation that
 * cannot be a *tool*.
 *
 * `people.people.get` is unreachable through the generated path, because
 * `{resourceName}` has its slash percent-encoded and `people/me` stops being a
 * path (see the note in `../specs/vendor.ts`). A literal URL has no placeholder
 * to encode, so the same call works here. `pluck` steps through the first array
 * element, which is what resolves `emailAddresses.value`.
 */
export const PEOPLE_IDENTITY = {
  kind: 'http',
  url: 'https://people.googleapis.com/v1/people/me?personFields=emailAddresses',
  field: 'emailAddresses.value',
} as const;

/** A vendored spec, addressed from this folder rather than by counting `..`. */
export function specPath(name: string): string {
  return new URL(`../specs/${name}`, import.meta.url).pathname;
}
