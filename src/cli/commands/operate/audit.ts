import { announce, print, style, table } from '../../output.ts';
import { openRuntime, type GlobalFlags } from '../../runtime.ts';

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

  const runtime = await openRuntime(flags);
  try {
    // The banner is chrome around a table; in Markdown it is a stray line in
    // the middle of a document someone is pasting somewhere.
    if (!markdown) announce(runtime.resolution);

    const events = await runtime.audit.tail({
      limit: flags.limit ?? 25,
      ...(flags.deniedOnly ? { deniedOnly: true } : {}),
    });

    if (events.length === 0) {
      print(markdown ? '_No audit events yet._' : style.dim('No audit events yet.'));
      return;
    }

    if (markdown) {
      // The log lives in the database; this is a rendering of it, not a second
      // copy of it. See ADR-013 — storage format and display format are not the
      // same decision.
      print(`# Audit — ${runtime.resolution.profile}\n`);
      print('| Time | Result | Capability | Connection | Duration | Arguments |');
      print('|---|---|---|---|---|---|');
      for (const event of events) {
        print(
          `| ${event.timestamp.toISOString()} ` +
            `| ${event.authorization} ` +
            `| \`${event.capability}\` ` +
            `| ${event.connection ?? ''} ` +
            `| ${event.durationMs}ms ` +
            `| ${markdownCell(JSON.stringify(event.arguments))} |`,
        );
      }
      return;
    }

    table(
      events.map((event) => [
        style.dim(event.timestamp.toISOString().slice(11, 19)),
        event.authorization === 'allowed' ? style.green('allow') : style.red('deny '),
        style.bold(event.capability),
        event.connection ?? '',
        style.dim(`${event.durationMs}ms`),
        style.dim(JSON.stringify(event.arguments)),
      ]),
    );
  } finally {
    await runtime.close();
  }
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
  const runtime = await openRuntime(flags);
  try {
    announce(runtime.resolution);
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
