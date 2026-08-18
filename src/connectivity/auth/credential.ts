/**
 * A credential, resolved but not yet attached to anything.
 *
 * The seam between "read the store and work out what this secret is" and "put
 * it on an outbound request". Two steps rather than one because not every
 * transport has a request to put it on: IMAP wants a username and password as a
 * pair, and gets this value directly.
 */
export type ResolvedCredential =
  | { readonly kind: 'none' }
  | { readonly kind: 'bearer'; readonly token: string; readonly header: string }
  | { readonly kind: 'basic'; readonly username: string; readonly password: string }
  | {
      readonly kind: 'api_key';
      readonly value: string;
      readonly header?: string;
      readonly query?: string;
    }
  | { readonly kind: 'oauth'; readonly accessToken: string };
