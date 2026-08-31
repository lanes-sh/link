import { recordTarget, resolveWorkspaceRoot, type TargetConfig } from '#profile';

/**
 * Writing down where a deployment lives, and what rolled it.
 *
 * **The target hands itself over to the workspace it now lives in.** Two writes,
 * and the order matters. The declaration goes into the bucket's own
 * `lanes-link.yaml` first, because that is the file the revision coming up will
 * read to learn where its credentials and bytes are — and a revision that boots
 * before it lands has nothing to open.
 *
 * The local entry then becomes a *pointer*. That is the whole of ADR-052 in two
 * lines: after this, exactly one file declares this target, and this machine
 * holds a reference to it rather than a copy. ADR-044's index existed because
 * the profile's own block was the only record and could be lost in one edit;
 * there is no second copy left to lose.
 */

export interface DeploymentRecord {
  /** Where the target's own workspace lives — the bucket, for a deployment. */
  readonly workspace: string;
  readonly target: string;
  readonly declared: TargetConfig;
  /** Whose bearer token opens the endpoint (ADR-009). */
  readonly primary: string;
  /** When this deploy ran, as an ISO instant. */
  readonly at: string;
  /**
   * The CLI release that rolled the revision, written only once it has rolled.
   *
   * The image is built from the installed package, so the version planning the
   * deploy *is* the version serving it — which makes this the one place either
   * end can be asked "what is up there" without a running endpoint to ask. The
   * bucket carries it as well as the laptop, so a second machine reading the
   * registry learns it too.
   *
   * Absent on the write that happens before the rollout, and that asymmetry is
   * the point: a build that fails must not leave a version recorded that never
   * served a request. The declaration has to land first (a revision that boots
   * without it has nothing to open); the version can only be true afterwards.
   */
  readonly version?: string | undefined;
}

export async function recordDeployment(record: DeploymentRecord): Promise<void> {
  const stamp = {
    primary: record.primary,
    last_deploy: record.at,
    ...(record.version ? { last_deploy_version: record.version } : {}),
  };

  await recordTarget(record.workspace, record.target, { ...record.declared, ...stamp });

  // **This machine's registry, not the target's.** The workspace a profile was
  // *found* in is the bucket for a deployed target — so writing the pointer
  // there pointed the bucket at itself, and the revision that came up refused to
  // open its own target.
  await recordTarget(resolveWorkspaceRoot(), record.target, {
    at: record.workspace,
    ...stamp,
  });
}
