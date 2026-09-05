/**
 * Which deployment this process is, and the refusal when it does not add up.
 *
 * A self-hosted deploy has one environment and no need for any of this. A
 * Lanes-hosted runtime has two, sharing a code path, a container image and a
 * cloud project — and the failure that matters is a staging revision reading
 * production's workspaces, which hold live OAuth refresh tokens.
 *
 * The Lanes API derives its stage configuration by overriding each secret
 * substitution individually, so a secret added to `cloudbuild.yaml` without a
 * matching override leaves stage reading the production secret. Nothing warns,
 * and two are already in that state. For a form endpoint that misroutes a
 * submission. Here it would be somebody's mailbox.
 *
 * So a managed deployment derives every location from one environment name and
 * checks what it derived. **A mismatch refuses to boot**, which is the whole
 * point: a mismatch that logs and serves anyway is the silent fallback with an
 * extra step, and the thing it would be protecting is the one asset in this
 * system that cannot be un-leaked.
 */

/** The deployments a managed runtime runs as. Not an open set, deliberately. */
export type Environment = 'prod' | 'stage';

const ENVIRONMENTS: readonly Environment[] = ['prod', 'stage'];

/**
 * The marker a non-production location has to carry.
 *
 * One substring rather than a pattern per location. A bucket, a hostname and a
 * secret prefix are spelled differently enough that any rule fitting all three
 * would be loose, and a loose rule here is worse than none — it would pass the
 * case it exists to catch.
 */
const STAGE_MARKER = 'stage';

/**
 * The environment named by a variable, or a refusal.
 *
 * There is no default, and that is the decision. An unset or misspelled
 * variable resolving to `prod` is precisely how a staging revision comes to
 * hold production's root, so an unrecognised value is a boot failure rather
 * than an assumption. `staging` is rejected alongside nonsense for the same
 * reason: one spelling, or the marker check below has two things to agree with.
 */
export function environmentFrom(value: string | undefined): Environment {
  const found = ENVIRONMENTS.find((environment) => environment === value);
  if (found) return found;

  throw new Error(
    `The deployment environment is ${JSON.stringify(value)}, which is not one of ` +
      `${ENVIRONMENTS.join(', ')}. Set it explicitly — there is no default, because a ` +
      'misspelled value defaulting to "prod" is how a staging revision comes to hold ' +
      "production's workspaces.",
  );
}

/**
 * Refuse a location that belongs to a different environment than this one.
 *
 * Called once per derived location at boot — the workspace root, the API URL,
 * the endpoint domain — rather than once over a bundle, so the refusal names
 * which one disagreed. A boot failure is read in a log with no command line to
 * inspect, so the message carries what the operator would otherwise go and find.
 */
export function assertEnvironmentMatches(input: {
  readonly environment: Environment;
  /** What is being checked, named in the refusal. */
  readonly what: string;
  readonly value: string;
}): void {
  const names = input.value.toLowerCase().includes(STAGE_MARKER);
  const shouldName = input.environment === 'stage';
  if (names === shouldName) return;

  throw new Error(
    `${input.what} is ${JSON.stringify(input.value)}, which ` +
      (shouldName
        ? `does not name "${STAGE_MARKER}" while this deployment is "stage". A stage ` +
          'deployment reading production storage is the failure this check exists for, ' +
          'so it refuses to start rather than serve.'
        : `names "${STAGE_MARKER}" while this deployment is "prod". A production ` +
          'revision pointed at staging storage serves an empty workspace, which reads ' +
          'as data loss.'),
  );
}
