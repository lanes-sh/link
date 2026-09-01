/**
 * Where the dashboard's pairing credentials live in a workspace's store.
 *
 * Here rather than beside the command that writes them, because three
 * components now read these names and only one of them is the CLI: the server
 * opens the read surface with them (`#server/read`), and a deploy binds the
 * token so the revision may read it (`#deployments/prepare.ts`). Importing a
 * *command* module for a string constant dragged `cli/output.ts`,
 * `cli/prompt.ts` and the terminal handling behind them into the container's
 * runtime graph, which is a large amount of the CLI to load in order to learn
 * three names.
 *
 * Underscores, not dots. A secret reference is `[a-z0-9_-]` separated by `/`
 * (see `isValidSecretRef`), and that is not arbitrary: these names become
 * Secret Manager entries on a deployed workspace, and Google allows no dots
 * there either. `workspace/pair.cert` was refused at the moment somebody first
 * ran the command.
 */

/** The credential the dashboard presents. Reads everything; can change nothing. */
export const PAIR_TOKEN_REF = 'workspace/pair_token';

/**
 * The certificate the loopback read listener terminates TLS with, and its key.
 *
 * Loopback only, and deliberately not bound on a deployed workspace: Cloud Run
 * terminates TLS with a certificate a browser already trusts, so a deployed
 * revision never calls `serveRead` and never reads either of these. Binding two
 * secrets nothing reads would say the boundary is wider than it is.
 */
export const PAIR_CERT_REF = 'workspace/pair_cert';
export const PAIR_KEY_REF = 'workspace/pair_key';
