import { planAll, planFor, type ProviderPlan } from '#providers/setup/plan.ts';
import { announce, emit, heading, paint, print, prose, steps, style, table } from '../output.ts';
import { missingRequirements } from './connect/requirements.ts';
import { openRuntime, type GlobalFlags } from '../runtime.ts';

/**
 * `lanes link setup plan [<provider>]` — what connecting something involves,
 * before you start.
 *
 * The CLI twin of the `setup.provider` capability, sharing `planFor` so the two
 * cannot disagree about what to run. This one also reports what is already
 * *satisfied*, which the capability deliberately does not: reading the
 * credential store to answer that is the control plane's job (ADR-007).
 */

export interface SetupFlags extends GlobalFlags {
  readonly json?: boolean | undefined;
  readonly id?: string | undefined;
}

export async function setupPlan(provider: string | undefined, flags: SetupFlags): Promise<void> {
  const runtime = await openRuntime(flags);

  try {
    const context = {
      profile: runtime.resolution.profile,
      target: runtime.resolution.target,
      connections: runtime.connections.map(({ ref }) => ref),
      // Declaring an `oauth_apps` entry is how a profile says "use my own
      // client". Without this the plan would tell someone who has already
      // registered one that they need nothing.
      ownClients: runtime.ownClients,
    };

    const manifests = runtime.registry.list().map((entry) => entry.manifest);

    if (provider) {
      const manifest = manifests.find((candidate) => candidate.id === provider);
      if (!manifest) {
        throw new Error(
          `Unknown provider "${provider}".\n  Run: lanes link setup plan   to see every one this build ships.`,
        );
      }

      const plan = planFor(manifest, context, flags.id);

      // With no id, a per-account ref is still the placeholder `<provider>/<id>`
      // — not a reference the store would accept, and not one anything could
      // have been written to. Asking is a malformed-reference error where the
      // honest answer is "name the connection first".
      const missing = plan.needsId
        ? new Set(plan.requires.map((requirement) => requirement.ref))
        : new Set(
            (await missingRequirements(plan.requires, runtime.credentials)).map(
              (requirement) => requirement.ref,
            ),
          );

      // Inside the render callback, not before it: `emit` returns the JSON
      // early, so this is where a line of prose is safe. `connect` needs its
      // own guard because its announce has to precede a browser.
      return emit(flags.json, { ...plan, missing: [...missing] }, () => {
        announce(runtime.resolution);
        renderOne(plan, missing);
      });
    }

    const plans = planAll(manifests, context);

    return emit(flags.json, { profile: context.profile, providers: plans }, () => {
      announce(runtime.resolution);
      heading(`Connected in ${style.bold(context.profile)}`);
      const done = plans.filter((plan) => plan.connected.length > 0);
      if (done.length === 0) print(style.dim('  nothing yet'));
      else table(done.map((plan) => [`  ${style.bold(plan.name)}`, style.dim(plan.connected.join(', '))]));

      heading('Available');
      table(
        plans
          .filter((plan) => plan.connected.length === 0)
          .map((plan) => [
            `  ${style.bold(plan.id)}`,
            plan.browser ? style.yellow('browser') : style.green('no browser'),
            style.dim(plan.description),
          ]),
      );

      print();
      print(style.dim('Detail for one: lanes link setup plan <provider>'));
    });
  } finally {
    await runtime.close();
  }
}

function renderOne(plan: ProviderPlan, missing: ReadonlySet<string>): void {
  heading(plan.name);
  prose(`  ${plan.description}`);
  if (plan.summary) prose(`  ${plan.summary}`, { paint: paint.muted });
  if (plan.docsUrl) print(`  ${paint.link(plan.docsUrl)}`);

  if (plan.connected.length > 0) {
    print();
    print(`  ${style.green('connected')}  ${plan.connected.join(', ')}`);
  }

  if (plan.steps.length > 0 && !plan.brokered) {
    heading('First, in the vendor’s console');
    steps(plan.steps);
  }

  if (plan.brokered) {
    heading('Values it needs');
    prose(
      `  none — the OAuth client is operated by ${plan.clientOperator}, and its secret never reaches this machine.`,
      { paint: paint.muted },
    );
  }

  if (plan.requires.length > 0) {
    heading('Values it needs');
    for (const requirement of plan.requires) {
      const state = missing.has(requirement.ref)
        ? style.yellow('not stored')
        : style.green('stored');
      print(`  ${style.bold(requirement.label)}  ${state}`);
      print(`    ${style.dim(requirement.ref)}`);
      if (missing.has(requirement.ref)) print(`    ${requirement.command}`);
    }
  }

  if (plan.variables.length > 0) {
    // Its own heading rather than a row under "Values it needs", because there
    // is nothing to store ahead of time: `connect` asks for these and writes
    // them to the connection, so the useful thing to show is what will be asked
    // and what an answer looks like.
    heading('Where it is');
    for (const variable of plan.variables) {
      print(`  ${style.bold(variable.label)}  ${style.dim(`e.g. ${variable.example}`)}`);
      prose(`    ${variable.description}`, { paint: paint.muted });
    }
  }

  heading('Then');
  print(`  ${plan.command}`);

  // Last, and headed as the alternative it is. Someone reading this wants the
  // one line that connects an account; the console walkthrough is for the
  // minority who cannot use the hosted client, and putting it first taught
  // everyone else that this provider is the hard one.
  if (plan.brokered && plan.ownClientCommand) {
    heading('Or register a client of your own');
    print(`  ${plan.ownClientCommand}`);
    if (plan.steps.length > 0) {
      print();
      steps(plan.steps);
    }
  }

  // The other alternative, and for the same reason it is down here: it is what
  // to do when the line above is refused by somebody who is not the reader.
  if (plan.tokenCommand && plan.pastedCredential) {
    heading('Or paste a token you already hold');
    print(`  ${plan.tokenCommand}`);
    prose(`  Asks for the ${plan.pastedCredential}.`, { paint: paint.muted });
    if (plan.steps.length > 0 && !plan.ownClientCommand) {
      print();
      steps(plan.steps);
    }
  }
  if (plan.browser) {
    print();
    prose(
      '  This one authorises in a browser, so it has to be run by whoever owns the account.',
      { paint: paint.muted },
    );
  }
}
