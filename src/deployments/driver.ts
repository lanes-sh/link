import type { DeployConfig, TargetConfig } from '#profile';

/**
 * What a deployment has to be able to do to be rolled out.
 *
 * `lanes link deploy` used to *be* the Cloud Run driver — the CLI imported it by
 * path, so the command's grammar was generic while its behaviour was one
 * vendor's. This interface is the seam that makes the README's existing claim
 * true: adding a host is a folder here and a case in `drivers.ts`, and nothing
 * else in the codebase learns about it.
 *
 * Everything a driver produces is **data**, not effects. `plan` and `provision`
 * return steps rather than running them, which is what lets `--dry-run` show a
 * deploy exactly as it will happen, and what lets the argv be asserted in a test
 * with no cloud project anywhere near it. `run` is the only method that touches
 * the world, and it takes one already-built step.
 */

export interface CommandResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeployStep {
  readonly title: string;
  /**
   * Arguments to the driver's own tool, one element each.
   *
   * Never a shell string. A service name carrying whitespace and a flag has to
   * arrive as one argument the tool rejects, not as an extra option it obeys.
   */
  readonly argv: readonly string[];
  /** A step whose failure is expected when the thing already exists. */
  readonly tolerateFailure?: boolean;
}

export interface PlanInput {
  readonly deploy: DeployConfig;
  readonly tag: string;
  readonly target: string;
  /**
   * The primary profile this revision serves.
   *
   * Required rather than optional: `deploy` names it (ADR-037), and a revision
   * that boots without `LANES_LINK_PROFILE` refuses. Leaving it optional here is
   * what let deployments ship without the variable at all.
   */
  readonly profile: string;
  /**
   * Where the running instance reads its config, as a store URL.
   *
   * Passed at rollout rather than baked into the image, because the bucket
   * belongs to the operator and the image is meant to serve any workspace
   * (ADR-023). Absent for a target that keeps its workspace on a filesystem,
   * which no deployment does.
   */
  readonly workspace?: string | undefined;
  /**
   * Environment the revision must read from its own credential store, as
   * variable name → credential reference.
   *
   * A reference rather than a value, and never a value: this argv is printed by
   * `--dry-run`, echoed by the platform, and kept in a revision's description
   * forever. The driver turns a reference into whatever its host calls a secret
   * mount — which for Cloud Run means knowing the id encoding, and is why that
   * translation lives behind this interface rather than in the generic command.
   */
  readonly secretEnv?: Readonly<Record<string, string>> | undefined;
}

export interface ProvisionInput {
  readonly deploy: DeployConfig;
  /** The whole target, because what needs creating follows from its adapters. */
  readonly declared: TargetConfig;
  readonly target: string;
  /**
   * Credential references the running revision rewrites, so provision can grant
   * each one and leave the rest of the store read-only.
   *
   * Passed in rather than derived here: it comes from the profile's connections
   * and their manifests, which `deployments` cannot reach on its own — see
   * `rotatableRefs` in `./prepare.ts`.
   */
  readonly rotatable?: readonly string[];
  /**
   * Credential references the running revision reads, so provision can bind
   * read on each one rather than across the whole project.
   *
   * Same provenance as `rotatable` and for the same reason — see `readableRefs`
   * in `./prepare.ts`. Empty or absent means the project-wide fallback, which is
   * what a target with no profile to walk still needs.
   */
  readonly readable?: readonly string[];
}

export interface SurveyInput {
  /** Whatever the config already says, so a re-run confirms rather than re-asks. */
  readonly current: Partial<DeployConfig>;
  readonly profile: string;
  /**
   * Whether this profile gates requests itself.
   *
   * It decides which `access` to propose: a profile with its own gate wants the
   * platform door open, because platform IAM in front of it admits only callers
   * that can mint the host's identity token — which no agent harness can.
   */
  readonly gated: boolean;
  /**
   * Whether the target exists at all, or only its `deploy` block is missing.
   *
   * A target that is already declared has its adapters chosen; asking again
   * would be offering to overwrite them. A target that does not exist needs all
   * of it, and every answer but the bucket name follows from the platform.
   */
  readonly adapters: boolean;
}

/**
 * A surveyed target, plus the profile-level settings its answers imply.
 *
 * `authorization` is separate because it does not live under `targets:` — it is
 * `auth.authorization`, and it applies to every target. It comes back from here
 * anyway because the question that decides it is a deployment question: whether
 * a remote client has to reach this endpoint. Nothing else in the config knows
 * to ask, which is why an endpoint that could not be added to a phone was the
 * default outcome of a first deploy.
 */
export interface SurveyResult {
  readonly target: TargetConfig;
  readonly authorization?: { readonly mode: 'self' } | undefined;
}

export interface DeployDriver {
  readonly platform: DeployConfig['platform'];
  /** The command line this driver shells out to, for printing a plan. */
  readonly tool: string;

  /** What is missing before this driver can run anything, or null. */
  preflight(): string | null;

  /** Ask for what the config does not say yet. Interactive. */
  survey(input: SurveyInput): Promise<SurveyResult>;

  /** Resources this driver can create for itself, in the order they must happen. */
  provision(input: ProvisionInput): Promise<DeployStep[]>;

  /** The rollout itself. */
  plan(input: PlanInput): DeployStep[];

  /** The public URL, or null if the service has none yet. */
  url(deploy: DeployConfig): Promise<string | null>;

  /**
   * Run one step's argv.
   *
   * Streamed by default, because a build takes minutes and silence for the
   * duration is indistinguishable from a hang. `quiet` captures instead, for the
   * short steps whose output is a wall of IAM policy nobody reads and whose
   * failure is usually "already there" — the caller decides what to say about
   * those rather than letting the tool say it.
   */
  run(argv: readonly string[], options?: { quiet?: boolean }): Promise<CommandResult>;
}
