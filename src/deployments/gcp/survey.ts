import { ConfigError, DEPLOY_DEFAULTS, type DeployConfig, type TargetConfig } from '#profile';
import { heading, print, style, waiting } from '#cli/output.ts';
import { ask, confirm } from '#cli/prompt.ts';
import type { SurveyInput, SurveyResult } from '../driver.ts';
import { activeProject, openBillingAccounts, projectExists } from './gcloud.ts';

/**
 * Asking for what the config does not say yet.
 *
 * `deploy` used to refuse a target with no deployment block and tell the
 * operator which four keys to go and write. That is a correct error message and
 * a bad first run: the command knows what it needs, it can offer a sensible
 * value for every one of them, and the answers belong in the file rather than in
 * a flag the operator has to remember next time.
 *
 * It then refused a target that did not exist at all, which was the same mistake
 * one level up. `credentials`, `storage` and `vault` have exactly one workable
 * answer each on Cloud Run — Secret Manager, a bucket, and the sealed document
 * beside the credentials — so a hand-written block could only ever be a
 * transcription, and a wrong transcription fails somewhere unhelpful. The
 * `filesystem` adapter in particular *appears* to work up here and loses
 * everything on the next instance recycle.
 *
 * Every default is something already true rather than something invented — the
 * project `gcloud` is pointed at, the profile's own name — so the common case is
 * a handful of presses of return.
 */

const DEFAULT_REGION = 'europe-west1';

/**
 * Five random letters, for the two namespaces that are global to all of Google.
 *
 * A project id and a bucket name are both unique across every Google Cloud
 * customer, so a memorable name is a name somebody already has. Google's own
 * console does the same thing for the same reason.
 *
 * Letters rather than digits so the result is still pronounceable, and drawn
 * from `crypto` rather than `Math.random` — not because a guessable bucket name
 * is an vulnerability on its own, but because these names end up published in a
 * URL and an unseeded PRNG that repeats across two machines produces a collision
 * that looks like a permissions bug.
 */
function randomSuffix(length = 5): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const bytes = crypto.getRandomValues(new Uint8Array(length));

  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
}

/**
 * The globally-unique name this deploy proposes for itself.
 *
 * One suffix, one name, used for **both** the project and the bucket — they are
 * separate namespaces, so the same string is free in one when it is free in the
 * other, and a deployment whose project and bucket are called the same thing is
 * one you can find either way round from either console.
 *
 * Generated exactly once. Every later deploy reads the name back out of the
 * profile, because the survey only runs for what the config does not say — a
 * second suffix would name a second empty project beside the one holding
 * everything.
 *
 * Sixteen characters, inside the project id limit of 30 and the bucket limit of
 * 63, with no profile name in it: the profile is in the *service* name, which is
 * the thing that has to differ when one project holds two of these.
 */
export function proposedName(suffix = randomSuffix()): string {
  return `lanes-link-${suffix}`;
}

/**
 * What the service is called when nobody says.
 *
 * It used to be the bare profile name — `personal`, in a project that may hold
 * a dozen unrelated services, saying nothing about what it is or who put it
 * there. `mcp` is the useful half: what this serves is an MCP endpoint, and that
 * is what someone finds it looking for months later.
 *
 * The profile stays in the middle because one workspace can deploy several, and
 * two profiles deploying to one project must not collide on a name.
 */
export function defaultServiceName(profile: string): string {
  return `lanes-link-${profile}-mcp`;
}

/**
 * The local part of the runtime service account, which has its own length rule.
 *
 * Service account ids are capped at 30 characters and a Cloud Run service name
 * at 49, so a legal service name can derive an illegal account. That failure is
 * one `gcloud iam service-accounts create` away from being silent — the step
 * tolerates failure, so the deploy would carry on and roll a revision with no
 * identity, and the first symptom would be it failing to read a secret.
 */
export function accountId(service: string): string {
  const proposed = `${service}-run`;
  if (proposed.length <= 30) return proposed;

  // Trim the service, not the suffix: `-run` is what says which account this is.
  return `${service.slice(0, 30 - '-run'.length).replace(/-+$/, '')}-run`;
}

export async function surveyCloudRun(input: SurveyInput): Promise<SurveyResult> {
  const { current, profile, gated, adapters } = input;

  heading('Where should this deploy?');
  print(style.dim('  Answers are written into your profile, so this is asked once.'));
  print('');

  const project = await askProject(current.project);
  const billing = await askBilling(project, current.billing_account);
  const region = await askWithDefault('  Region', current.region ?? DEFAULT_REGION);
  const service = await askWithDefault(
    '  Cloud Run service name',
    current.service ?? defaultServiceName(profile),
  );

  // Not asked. A revision needs an identity that can read the credential store,
  // and the only interesting choice is *whether* it is dedicated — which it
  // should always be, because the default compute account is shared with
  // everything else in the project.
  const serviceAccount =
    current.service_account ?? `${accountId(service)}@${project}.iam.gserviceaccount.com`;

  const access = await askAccess(current.access, gated);

  const deploy: DeployConfig = {
    platform: 'cloudrun',
    // Not asked about. Zero is right for almost every target and the question
    // would cost every operator a decision to buy one of them a knob.
    min_instances: current.min_instances ?? 0,
    // Not asked about either, and for a stronger version of the same reason: a
    // ceiling is only interesting to somebody who has already hit it, and the
    // defaults are the ones a single-user endpoint wants. Carried through from
    // what the target already says so that an operator who *has* edited them
    // keeps their edit — pressing return through the survey changes nothing,
    // which is the property every other field here has too.
    max_instances: current.max_instances ?? DEPLOY_DEFAULTS.max_instances,
    concurrency: current.concurrency ?? DEPLOY_DEFAULTS.concurrency,
    timeout_seconds: current.timeout_seconds ?? DEPLOY_DEFAULTS.timeout_seconds,
    memory: current.memory ?? DEPLOY_DEFAULTS.memory,
    cpu: current.cpu ?? DEPLOY_DEFAULTS.cpu,
    project,
    region,
    service,
    access,
    service_account: serviceAccount,
    ...(billing ? { billing_account: billing } : {}),
  };

  // Only the `deploy` block was missing: the adapters are already chosen, and
  // re-asking would be offering to overwrite a working target.
  if (!adapters) return { target: { deploy } as TargetConfig };

  // The project's own name. One deployment, one string: the bucket namespace is
  // separate from the project namespace, so a name free in one is free in the
  // other, and finding either from the other needs nothing written down.
  const bucket = await askBucket(project);

  return {
    target: {
      credentials: { adapter: 'gcp-secret-manager', project },
      storage: { adapter: 'gcs', bucket },
      // Not optional, and not a preference. The default is `file`, which wants a
      // filesystem path, and this workspace lives in a bucket — so a target
      // without this line parses, deploys, and refuses to boot.
      vault: { adapter: 'secret' },
      deploy,
    } as TargetConfig,
    ...(access === 'public' && !gated && (await askRemoteClients()) ? { authorization: { mode: 'self' } } : {}),
  };
}

/**
 * Which project this deploys into, or the one it is about to create.
 *
 * The default used to be whatever `gcloud config` was pointed at, which is
 * whichever project you last worked on — a value that is *always* set, rarely
 * the right one, and wrong in the most expensive direction: accepting it deploys
 * a personal gateway holding live refresh tokens into a project shared with
 * something else. A fresh id proposes the opposite default, and typing an
 * existing name over it is one line.
 */
async function askProject(current: string | undefined): Promise<string> {
  const active = await waiting('reading your gcloud configuration', activeProject);

  print('  A project of its own is the cleanest home for this — it holds the bucket,');
  print(
    style.dim(
      '  the credential store, and nothing else. A new id is proposed; type the name\n' +
        `  of an existing project to deploy into that instead${active ? ` (yours is ${active})` : ''}.`,
    ),
  );

  return askWithDefault('  Google Cloud project', current ?? proposedName());
}

/**
 * The billing account, asked only when there is a project to attach it to.
 *
 * Skipped entirely for a project that already exists — it is already billed, or
 * it is not and that is not this command's business. Asking anyway would be a
 * question with no consequence, which is the kind that teaches people to press
 * return without reading.
 *
 * Refused rather than defaulted when there is no open account: a project created
 * without billing enables no APIs, and every step after it fails with a message
 * about the API rather than about billing.
 */
async function askBilling(project: string, current: string | undefined): Promise<string | undefined> {
  if (current) return current;
  if (await waiting(`checking whether ${project} exists`, () => projectExists(project))) {
    return undefined;
  }

  const accounts = await waiting('listing your billing accounts', openBillingAccounts);
  print('');
  print(`  ${style.bold(project)} does not exist yet, so this deploy will create it.`);
  print(style.dim('    A new project needs a billing account before any API can be enabled.'));

  if (accounts.length === 0) {
    throw new ConfigError(
      `No open billing account found for this login, and "${project}" would have to be created.\n` +
        '  Either name an existing project at the prompt, or set one up at\n' +
        '  https://console.cloud.google.com/billing and re-run.',
    );
  }

  for (const account of accounts) print(style.dim(`    ${account.id}  ${account.name}`));
  return askWithDefault('  Billing account', accounts[0]!.id);
}

/**
 * The one derived name that can collide with a stranger's.
 *
 * Bucket names are global across every Google Cloud customer, so this is asked
 * rather than assumed even though the default is almost always free. `taken` is
 * not a failure worth a stack trace three steps later.
 */
async function askBucket(project: string): Promise<string> {
  print('');
  print('  A bucket holds everything this endpoint remembers:');
  print(
    style.dim(
      '    its config, its connection state, the audit log, memory, skills and\n' +
        '    attachments. Named after the project by default; bucket names are\n' +
        '    globally unique, so this one may be taken even when the project was not.',
    ),
  );
  return askWithDefault('  Bucket', project);
}

/**
 * Whether a remote client has to reach this, which is what `mode: self` decides.
 *
 * Asked, and asked here, because nothing else in a first run does. `access:
 * public` opens the platform's door; it does not give a Claude or ChatGPT
 * connector any way to *obtain* a token, and those clients have nowhere to paste
 * a fixed one. Without `auth.authorization` the endpoint answers a connector's
 * handshake with a 401 carrying nothing to act on, which reads as a broken
 * server rather than a missing setting — so the previous default outcome of a
 * first deploy was an endpoint that could not be added to a phone, and no
 * message anywhere said why.
 */
async function askRemoteClients(): Promise<boolean> {
  print('');
  print('  Will you add this to Claude or ChatGPT, including on a phone?');
  print(
    style.dim(
      '    yes  this endpoint issues its own tokens — the client registers itself,\n' +
        '         a browser opens on its approval page, you paste the token once.\n' +
        '         Nothing to set up: no OAuth client, no console, no redirect URI.\n' +
        '    no   the bearer token is the only way in, which is all a local\n' +
        '         registration needs. Add it later under auth.authorization.',
    ),
  );
  return confirm('  Issue tokens for remote clients?');
}

/**
 * Which door the platform leaves open.
 *
 * Asked rather than assumed, and asked with the consequence attached, because
 * the two answers fail in opposite directions and neither failure is legible
 * from the outside: `iam` looks like a broken endpoint to every MCP client, and
 * `public` on a profile with no gate of its own is an open endpoint that answers
 * normally.
 */
async function askAccess(
  current: DeployConfig['access'] | undefined,
  gated: boolean,
): Promise<DeployConfig['access']> {
  const proposed = current ?? (gated ? 'public' : 'iam');

  print('');
  print('  Who may reach the service?');
  print(
    style.dim(
      '    iam     the platform checks a Google identity token first. Nothing that\n' +
        '            cannot mint one gets through — which includes every agent harness.\n' +
        '    public  the platform lets the request in and this endpoint authenticates it.',
    ),
  );
  if (gated) {
    print(
      style.dim(
        '    This profile authenticates requests itself, so "public" is the working\n' +
          '    choice — "iam" in front of it would lock out the clients it exists for.',
      ),
    );
  }

  const answer = (await askWithDefault('  Access', proposed)).toLowerCase();
  return answer === 'public' ? 'public' : 'iam';
}

/**
 * Ask, showing the default, and take it on an empty answer.
 *
 * Refuses an empty value with no default rather than writing one: an empty
 * service name parses, reaches `gcloud`, and fails several minutes into a build.
 */
async function askWithDefault(question: string, fallback: string | null | undefined): Promise<string> {
  const shown = fallback ? `${question} ${style.dim(`[${fallback}]`)}` : question;

  for (;;) {
    const answer = (await ask(shown)).trim();
    if (answer) return answer;
    if (fallback) return fallback;
    print(style.dim('    Required.'));
  }
}
