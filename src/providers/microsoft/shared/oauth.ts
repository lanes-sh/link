/** The `oauth_apps` entry every Microsoft provider authorises against. */
export const MICROSOFT_APP = 'microsoft';

/**
 * One app registration, five providers.
 *
 * Microsoft Graph is a single API behind mail, calendars, contacts, files and
 * to-do, so unlike Google — where each product has its own client and its own
 * consent screen — there is one Entra registration here and the providers differ
 * only in what they ask it for. The token still lands per provider, exactly as
 * Gmail's and Drive's do: `app` moves where the *client* comes from, never where
 * the tokens go, so connecting Outlook mail does not silently grant OneDrive.
 */

/** `common` rather than a tenant id: personal accounts and work accounts both. */
export const MICROSOFT_AUTHORIZE_URL =
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
export const MICROSOFT_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

/**
 * Asked for by every provider, and neither reaches a service.
 *
 * `offline_access` is not optional and is the one to get wrong: Microsoft issues
 * no refresh token without it, so the connection authorises cleanly, works for
 * about an hour, and then stops. That is the same failure Google's
 * `access_type=offline` exists to prevent, and it is worth naming because the
 * successful-looking response is what makes it hard to debug an hour later.
 *
 * `User.Read` is what the identity probe reads — the account's own name and
 * address, so a connection can be labelled with whose it is. It reaches no
 * mailbox, no calendar, and no file.
 */
export const MICROSOFT_BASE_SCOPES = ['offline_access', 'User.Read'] as const;

export const MAIL_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Mail.ReadWrite', 'Mail.Send'];
export const CALENDAR_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Calendars.ReadWrite'];
export const CONTACTS_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Contacts.Read'];
export const FILES_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Files.ReadWrite'];
export const TODO_SCOPES = [...MICROSOFT_BASE_SCOPES, 'Tasks.ReadWrite'];

/**
 * Whose account this is, for the label a connection is listed under.
 *
 * `userPrincipalName` rather than `mail`: a personal Microsoft account often has
 * no `mail` at all, and a null there would send `connect` to its "which account
 * is this?" fallback on exactly the accounts this is most useful for.
 */
export const MICROSOFT_IDENTITY = {
  kind: 'http' as const,
  url: 'https://graph.microsoft.com/v1.0/me',
  field: 'userPrincipalName',
};

/** Graph is one host and one version, for all five. */
export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';

export const specPath = (file: string): string =>
  new URL(`../specs/${file}`, import.meta.url).pathname;
