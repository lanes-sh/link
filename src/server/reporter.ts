/**
 * What `startEndpoint` tells its caller while it comes up.
 *
 * Separate from `endpoint.ts` because the two have different subjects: that
 * file decides what the endpoint serves, this one decides what it says about
 * what it could not. They were one file until the reporter grew a third hook
 * and pushed it past the size budget, which is the seam the budget exists to
 * find.
 */

export interface EndpointReporter {
  /** A profile whose runtime state differed from its config, and what was applied. */
  reconciled(input: { profile: string; plan: string; ofMany: boolean }): void;
  /**
   * A sibling profile that could not be opened against this target.
   *
   * Optional because it is new and every caller predates it, and because
   * silence is a defensible reading for a caller that only wants what it got.
   */
  skipped?(input: { profile: string; reason: string }): void;
  /**
   * A declared connection whose credential the store refused to hand over.
   *
   * Reported separately from `reconciled` because it is a standing fault rather
   * than a change, and `reconciled` only fires when the plan is not a no-op. The
   * first boot after a credential becomes unreadable flips it to `unauthorized`
   * and so does say something; every boot after that is a no-op plan, and the
   * endpoint would serve on in silence about the connection it cannot use.
   */
  unreadable?(input: { connection: string; reason: string }): void;
}

export const SILENT: EndpointReporter = { reconciled() {} };

/** The first line of an error, which is the part fit to print beside a name. */
export function message(error: unknown): string {
  return error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error);
}
