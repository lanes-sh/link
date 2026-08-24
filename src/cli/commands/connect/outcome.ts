import type { SetupRequirement } from '#connectivity';
import { fail, ok, print, progress, style } from '../../output.ts';
import type { Blocked } from './requirements.ts';

/**
 * What `connect` did, and how it is drawn.
 *
 * Split from the five steps that produce it because they change for different
 * reasons: the orchestration is about vendors and credentials, this is about
 * what a caller is told. It is also the only way the rendering gets tested —
 * `connect` needs a runtime, a config file, and a credential store to reach the
 * last line, and none of that is needed to check that a refusal names the
 * command that fixes it.
 */

export interface ConnectOutcome {
  readonly ok: boolean;
  readonly key?: string;
  readonly account?: string;
  readonly changes: readonly string[];
  readonly granted: readonly string[];
  /**
   * Prose about what was done, for a reader rather than for a filter.
   *
   * `changes` and `granted` are lists a `--json` caller counts and matches on,
   * so a sentence in either is something it has to recognise and skip. A change
   * the operator did not ask for still needs explaining — the setup repair adds
   * a provider they never named — and this is where that explanation goes.
   */
  readonly notes?: readonly string[];
  readonly discovered: number;
  /** How many of those write, so a grant can be narrowed knowingly. */
  readonly writable?: number;
  readonly reason?: Blocked['reason'];
  readonly message?: string;
  readonly needs?: readonly SetupRequirement[];
  readonly then?: string;
  /** One per service, when the target named an account several providers share. */
  readonly members?: readonly ConnectOutcome[];
  readonly next?: string;
}

/** A result that changed nothing, for the paths that stop early. */
export const NOTHING = { changes: [], granted: [], discovered: 0 } as const;

export const ALREADY = 'Already connected — nothing changed.';

/**
 * What `connect` says last.
 *
 * It used to be a guess: "restart the endpoint", or "run lanes link deploy" for
 * a deployable target, because a running endpoint read its config once at
 * startup and there was no way to reach it in between. Saying the wrong one was
 * worse than saying nothing — told to restart `lanes link start` after
 * authorising an account against a deployment, an operator restarts a server
 * that was not serving it and watches the deployed one go on refusing.
 *
 * The guess is gone. `connect` publishes the config where the target reads it
 * and asks the endpoint to re-read it, so the line reports what happened rather
 * than predicting it — see `nextAfterEdit` in `#cli/publish.ts` and ADR-029.
 */

export function renderOutcome(outcome: ConnectOutcome): void {
  // Each member already rendered itself as it ran; a summary here would print
  // the same facts a second time.
  if (outcome.members) return;

  if (!outcome.ok) return renderBlocked(outcome);

  if (outcome.next === ALREADY) {
    print(style.dim(`${outcome.key} is already connected.`));
    return;
  }

  print();
  print(ok(`connected ${style.bold(outcome.key ?? '')}`));
  for (const change of outcome.changes) print(`      ${style.dim(change)}`);
  for (const rule of outcome.granted) print(`      ${style.dim(`policy.allow += ${rule}`)}`);
  for (const note of outcome.notes ?? []) print(`      ${style.dim(note)}`);

  if (outcome.discovered > 0) {
    print(`      ${style.dim(`${outcome.discovered} capabilities discovered, all reachable`)}`);

    if ((outcome.writable ?? 0) > 0) {
      const provider = outcome.key?.split('.')[0] ?? '';
      print(
        `      ${style.dim(`${outcome.writable} of them write — lanes link policy deny ${provider}.<capability> to withhold one`)}`,
      );
    }
  }

  print();
  print(style.dim(`Next: ${outcome.next}`));
}

/**
 * A refusal, with every value it is waiting for and the command that ends it.
 *
 * All of it on stdout rather than stderr: this *is* the command's product when
 * it cannot connect, and it is what somebody copies.
 */
function renderBlocked(outcome: ConnectOutcome): void {
  progress();
  print(fail(outcome.reason === 'needs_browser' ? 'a browser is needed' : 'more is needed first'));

  for (const line of (outcome.message ?? '').split('\n')) print(`      ${line}`);

  for (const need of outcome.needs ?? []) {
    print();
    print(`      ${style.bold(need.label)}`);
    print(`      ${style.dim(`→ ${need.ref}`)}`);
    print(`      ${need.command}`);
  }

  if (outcome.then) {
    print();
    print(`      ${outcome.then}`);
  }
}
