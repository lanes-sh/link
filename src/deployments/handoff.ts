import { TARGET_ENV } from '#profile';
import { style } from '#cli/output.ts';

/**
 * What a deploy leaves the operator's *next* command pointing at.
 *
 * `deploy` is the one command that works out its own target — the one declaring
 * a `deploy` block, per `resolveDeployTarget` — and it changes nothing about
 * where every other command runs. That is correct, and it is invisible: a
 * profile scaffolded with `default_target: local` still resolves `local`
 * afterwards, so the `connect` typed straight after a successful deploy writes
 * the account into the local credential store and the revision that just rolled
 * goes on refusing it. Nothing in either command's output disagrees.
 *
 * Its own file rather than a private function in `deploy.ts` because that is
 * what makes it testable: `deploy.test.ts` does not import `deploy.ts`, and
 * making it do so would drag the whole CLI runtime — every provider manifest —
 * into a unit test, along with a `deployments → cli → deployments` cycle.
 */

export function defaultTargetHandOff(input: {
  /** The target that was just deployed. */
  readonly deployed: string;
  /** `instance.default_target` — what the profile says. */
  readonly defaultTarget: string;
  /**
   * `LANES_LINK_TARGET`, when this shell exports one.
   *
   * Read here, and deliberately, though `resolveDeployTarget` refuses to read it
   * three files away. The two rules answer different questions. There it governs
   * *what gets deployed*, where a stray export could name a Cloud Run service
   * into existence. Here it governs *what the operator's next command will do* —
   * and their next command genuinely does read it, so a prediction that ignored
   * it would be wrong exactly when it matters.
   */
  readonly fromEnv?: string | undefined;
}): string | null {
  // What a bare command resolves to, not what the file says. A profile left at
  // `local` with `LANES_LINK_TARGET` already exported as the deployed target
  // lands there anyway, and telling that operator to fix something is noise.
  const bare = input.fromEnv ?? input.defaultTarget;
  if (bare === input.deployed) return null;

  // Naming whichever one is actually winning. Telling someone to run
  // `target use` while a variable overrides the file is advice that changes the
  // file and nothing else — which is the case `target use` itself warns about
  // from the other end.
  const why =
    input.fromEnv !== undefined
      ? `${TARGET_ENV}="${input.fromEnv}" is set in this shell and wins over the file, so`
      : `instance.default_target is still "${input.defaultTarget}" — deploying did not change it, so`;

  const connect = `lanes link connect <provider> --target ${input.deployed}`;
  const settle =
    input.fromEnv !== undefined
      ? `export ${TARGET_ENV}=${input.deployed}`
      : `lanes link target use ${input.deployed}`;

  const width = Math.max(connect.length, settle.length) + 3;

  return style.dim(
    `  ${why}\n` +
      `  a command without --target still acts on "${bare}", which this deployment cannot read.\n` +
      `    ${connect.padEnd(width)}for one account\n` +
      `    ${settle.padEnd(width)}${input.fromEnv !== undefined ? 'for this shell' : 'for good'}`,
  );
}
