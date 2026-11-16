import { announceWorkspace, print, printable, style, table } from '../../output.ts';
import { openWorkspaceRuntime, type GlobalFlags } from '../../runtime.ts';

/** `lanes link audit tail` — the log the dispatcher writes, rendered for a terminal. */

export async function auditTail(
  flags: GlobalFlags & {
    limit?: number | undefined;
    deniedOnly?: boolean | undefined;
    format?: string | undefined;
  },
): Promise<void> {
  if (flags.format !== undefined && flags.format !== 'text' && flags.format !== 'md') {
    throw new Error(`Unknown audit format "${flags.format}" — expected "text" or "md".`);
  }
  const markdown = flags.format === 'md';

  const runtime = await openWorkspaceRuntime(flags);
  try {
    // The banner is chrome around a table; in Markdown it is a stray line in
    // the middle of a document someone is pasting somewhere.
    if (!markdown) announceWorkspace(runtime.resolution);

    const page = await runtime.audit.tail({
      limit: flags.limit ?? 25,
      ...(flags.deniedOnly ? { deniedOnly: true } : {}),
      // `audit` is a workspace-level command: the log is one chain covering
      // every profile, so `--profile` narrows the rows rather than choosing
      // which log to read. `selection.ts` has said so since contract 3 and
      // nothing implemented it, which made the flag accepted and ignored —
      // two profiles returned byte-identical rows and neither said which
      // profile it was describing.
      ...(flags.profile ? { profiles: [flags.profile] } : {}),
    });
    const { events } = page;

    if (events.length === 0) {
      const scope = flags.profile ? ` for profile "${flags.profile}"` : '';
      const nothing = page.complete
        ? `No audit events yet${scope}.`
        : `No audit events${scope} in the ${page.scanned} most recent entries.`;
      print(markdown ? `_${nothing}_` : style.dim(nothing));
      return;
    }

    if (markdown) {
      // The log lives in the database; this is a rendering of it, not a second
      // copy of it. See ADR-013 — storage format and display format are not the
      // same decision.
      // The workspace, not the profile. Contract 3 gave the workspace one
      // chain covering every profile in it, and a heading naming whichever
      // profile happened to open the store described a log that does not
      // exist. Each row carries its own profile, and now says so.
      print(`# Audit — ${runtime.resolution.target}\n`);
      print(
        '| Time | Result | Profile | Principal | Client | Capability | Connection | Duration | Arguments |',
      );
      print('|---|---|---|---|---|---|---|---|---|');
      for (const event of events) {
        print(
          `| ${event.timestamp.toISOString()} ` +
            `| ${event.authorization} ` +
            `| ${event.profile} ` +
            `| ${event.principal} ` +
            `| ${markdownCell(printable(event.clientLabel ?? '—'))} ` +
            `| \`${event.capability}\` ` +
            `| ${event.connection ?? ''} ` +
            `| ${event.durationMs}ms ` +
            `| ${markdownCell(JSON.stringify(event.arguments))} |`,
        );
      }
      if (!page.complete) print(`\n_${truncationNote(page.scanned)}_`);
      return;
    }

    table(
      events.map((event) => [
        style.dim(event.timestamp.toISOString().slice(11, 19)),
        event.authorization === 'allowed' ? style.green('allow') : style.red('deny '),
        event.profile,
        style.dim(shortPrincipal(event.principal, event.profile)),
        style.dim(printable(event.clientLabel ?? '—', 14)),
        style.bold(event.capability),
        event.connection ?? '',
        style.dim(`${event.durationMs}ms`),
        style.dim(JSON.stringify(event.arguments)),
      ]),
    );

    // A tail that stopped early has to say so. Without this the answer is
    // indistinguishable from a complete one, which is the whole defect: asking
    // for a hundred rows of one profile and being handed thirty reads exactly
    // like "there are only thirty".
    if (!page.complete) print(style.dim(`\n${truncationNote(page.scanned)}`));
  } finally {
    await runtime.close();
  }
}

function truncationNote(scanned: number): string {
  return `scanned the ${scanned} most recent entries; older ones were not reached — narrow with --since, or raise --limit.`;
}

/**
 * A principal, minus the part the row beside it already says.
 *
 * Every principal is scoped to a profile, so in a table that now carries a
 * profile column the prefix is printed twice on every row — `personal` then
 * `personal:owner`. The column exists to tell two callers apart, and the half
 * that does that is the half after the colon.
 *
 * Only when it matches: a principal scoped to another profile keeps its prefix,
 * because then the difference is the interesting part.
 */
function shortPrincipal(principal: string, profile: string): string {
  const stripped = principal.startsWith(`${profile}:`)
    ? principal.slice(profile.length + 1)
    : principal;
  return printable(stripped, 20);
}

/**
 * `lanes link audit verify` — has anything in the log been altered or removed?
 *
 * The question a log that lives in ordinary files has to be able to answer.
 * Each record carries the hash of the one before it within its run, so this
 * walks every chain and reports the first break in each: an edit shows as a
 * hash mismatch, a removal from the middle as a sequence gap, and a run that
 * was cut short after a clean shutdown as a count that disagrees with its
 * marker.
 *
 * It exits non-zero on a break so a cron job can be built on it, and prints
 * what it checked either way — "nothing to report" is only reassuring if you
 * can see how much was looked at.
 */
export async function auditVerify(flags: GlobalFlags): Promise<void> {
  const runtime = await openWorkspaceRuntime(flags);
  try {
    announceWorkspace(runtime.resolution);
    const report = await runtime.audit.verify();

    const scope = `${report.events} event${report.events === 1 ? '' : 's'} across ${report.runs} run${report.runs === 1 ? '' : 's'}`;

    if (report.ok) {
      print(`${style.green('intact')} — ${scope}, every chain verified.`);
      return;
    }

    print(`${style.red('BROKEN')} — ${scope}.\n`);
    for (const found of report.breaks) {
      print(`  ${style.bold(found.kind.padEnd(9))} run ${found.run} at seq ${found.seq}`);
      print(`  ${style.dim(found.detail)}\n`);
    }

    // A break means somebody edited the log, or something corrupted it. Either
    // way this must not look like success to whatever ran it.
    process.exitCode = 1;
  } finally {
    await runtime.close();
  }
}

/**
 * A value safe to put in a Markdown table cell.
 *
 * Redacted arguments are still attacker-influenced — a provider that keeps a
 * key verbatim is keeping whatever the caller sent — so a pipe or a newline in
 * one would otherwise break the table apart or forge a row.
 */
export function markdownCell(value: string): string {
  return `\`${value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll(/[\r\n]+/g, ' ')}\``;
}
