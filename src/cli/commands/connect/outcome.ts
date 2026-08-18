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
 * A running endpoint reads its config once, at startup.
 *
 * `connect` used to say "Next: lanes link start", which reads as "you are done"
 * to someone who already has one running. They then ask an agent that cannot
 * see the new connection, and the endpoint is not wrong — it is serving the
 * config it was started with.
 *
 * Which endpoint that is depends on the target, and saying the wrong one is
 * worse than saying nothing: told to restart `lanes link start` after
 * authorising an account against a deployment, an operator restarts a server
 * that was not serving it and watches the deployed one go on refusing. A
 * deployed instance is replaced rather than restarted, and the config it reads
 * lives in a bucket that `deploy` uploads — so the revision and the config it
 * needs arrive by the same command.
 */
export const RESTART = 'Restart the endpoint to serve it: stop lanes link start, then run it again.';

export const REDEPLOY =
  'Roll a revision so the deployed endpoint serves it: lanes link deploy\n' +
  '      It decides which connections are usable when it boots, so the one running now\n' +
  '      keeps refusing this account until a new revision replaces it.';

/** Which of the two a target has. */
export function nextAfterConnect(deployable: boolean): string {
  return deployable ? REDEPLOY : RESTART;
}

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
