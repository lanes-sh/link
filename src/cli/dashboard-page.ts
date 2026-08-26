import { PROVIDER_MANIFESTS } from '#providers/index.ts';
import { planAll, type ProviderPlan } from '#providers/setup/plan.ts';
import { PROVIDER_MARKS } from './provider-marks.ts';
import { escapeHtml } from './brand.ts';
import { shell } from './dashboard-shell.ts';

/**
 * The dashboard — one page answering what `status`, `setup plan` and
 * `target list` answer between them.
 *
 * It renders and it does not act. Every state-changing thing on it is a command
 * to paste, for two reasons that are not the same. Connecting is ADR-005: the
 * consent belongs to whoever owns the browser, and the loopback listener that
 * receives the code is the CLI's. Everything else is ADR-007: config is written
 * from the control plane, and a page served by the endpoint is not it.
 *
 * So this is a reader, and the honest shape of a reader is a page that tells you
 * the line to run. What it saves is not typing — it is knowing which line.
 *
 * The design is `callback-page.ts`'s, because that is the product's page and
 * this is the same product: nothing painted (`color-scheme: light dark` over a
 * transparent background, correct in either mode with no theme switch), Lora on
 * the heading, and colour reserved for status rather than spent on emphasis.
 * What differs is the width — a card centred at 460px is right for one sentence
 * and wrong for four sections.
 */

export interface DashboardConnection {
  /** `provider.id`, the key everything else addresses this by. */
  readonly key: string;
  readonly provider: string;
  readonly account: string;
  /** `active`, `unauthorized`, `disabled`, or `not reconciled`. */
  readonly state: string;
}

export interface DashboardView {
  /** The profile being rendered, which `?profile=` may have chosen. */
  readonly profile: string;
  /** Every profile this endpoint serves, for the switcher. */
  readonly profiles: readonly string[];
  /** The target whose adapters are open. */
  readonly target: string;
  /** Every target the profile declares, live or not. */
  readonly targets: readonly string[];
  readonly connections: readonly DashboardConnection[];
  /** `oauth_apps` keys, so a profile with its own client is described as having one. */
  readonly ownClients: readonly string[];
}

/**
 * Every command this page renders, built in one place.
 *
 * `--profile` and `--target` on all of them, unconditionally. The shell a line
 * is pasted into resolves both for itself — from `LANES_LINK_PROFILE` and
 * `LANES_LINK_TARGET`, or from the workspace default — and a page that shows
 * you one profile while handing you a command that silently acts on another is
 * worse than one that shows nothing. It is also the rule `resolveSelection`
 * already follows by refusing to guess.
 */
function command(view: DashboardView, rest: string): string {
  return `lanes link ${rest} --profile ${view.profile} --target ${view.target}`;
}

/**
 * A command, shown in full.
 *
 * Kept for the two places where the command *is* the label — the sign-in page
 * and the footer — because there is no provider name to carry it. Everywhere
 * else the line is on the button, not on the page; see `copyButton`.
 */
function commandLine(line: string): string {
  const text = escapeHtml(line);
  return (
    `<div class="cmd"><code>${text}</code>` +
    `<button class="btn copy" type="button" data-copy="${text}" aria-label="Copy command">copy</button></div>`
  );
}

/**
 * The command, on the button rather than beside it.
 *
 * What this trades away is worth naming: the line is no longer selectable by
 * hand, so a browser with no clipboard API leaves no way to get it. That is
 * narrower than it sounds — `navigator.clipboard` needs a secure context, and
 * `http://127.0.0.1` is one by definition, which is the only address this page
 * is ever served on. The `title` carries the text for anyone who wants to read
 * before pasting, and `lanes link setup plan` prints the same lines.
 */
function copyButton(line: string, label: string): string {
  const text = escapeHtml(line);
  return (
    `<button class="btn copy" type="button" data-copy="${text}" title="${text}" ` +
    `aria-label="Copy the command that connects ${escapeHtml(label)}">copy</button>`
  );
}

/**
 * The provider's mark, or letters standing in for one.
 *
 * `aria-hidden` on both: every caller puts the name beside it, and a screen
 * reader announcing "GitHub, GitHub" is worse than one announcing it once.
 *
 * The fallback takes the first letter of the family and two of the member,
 * because the plain two collapse a catalogue holding four `icloud_*` entries
 * and two `*_mcp` ones into a handful of identical marks — `ICA` and `ICO`
 * rather than `IC` twice.
 */
function mark(id: string): string {
  const path = PROVIDER_MARKS[id];
  if (path) {
    return (
      '<svg class="glyph" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      `<path d="${path}"/></svg>`
    );
  }

  const [family, member] = id.split('_');
  const letters = member ? `${family![0]}${member.slice(0, 2)}` : id.slice(0, 2);
  return `<span class="glyph letters" aria-hidden="true">${escapeHtml(letters.toUpperCase())}</span>`;
}

/**
 * The state, as one of the design system's badge variants.
 *
 * "Gold for positive, neutral tokens otherwise" — so `active` is the only gold
 * one, and `unauthorized` is *neutral* rather than red. It is not an error: the
 * credential is absent from this target's store, which is a thing to do, and
 * `--destructive` is reserved for something having gone wrong. `disabled` is
 * quieter still, being a row that config no longer declares.
 */
function statusPill(state: string): string {
  const kind = state === 'active' ? 'positive' : state === 'disabled' ? 'quiet' : 'neutral';
  return `<span class="pill ${kind}">${escapeHtml(state)}</span>`;
}

function connectionsSection(view: DashboardView): string {
  if (view.connections.length === 0) {
    return '<p class="empty">Nothing connected in this profile yet. Pick one below.</p>';
  }

  const rows = view.connections
    .map((connection) => {
      // A connection that is not active is one the reader can act on, and the
      // action is the same `connect` that made it — re-running against an
      // existing key repairs it rather than adding a second account. An active
      // one has nothing to do, so it carries no button.
      const repair =
        connection.state === 'active'
          ? ''
          : copyButton(command(view, `connect ${connection.key}`), connection.key);

      return (
        '<div class="row">' +
        mark(connection.provider) +
        `<code class="key">${escapeHtml(connection.key)}</code>` +
        statusPill(connection.state) +
        `<span class="account">${escapeHtml(connection.account)}</span>` +
        repair +
        '</div>'
      );
    })
    .join('\n');

  return `<div class="rows">${rows}</div>`;
}

/**
 * One provider, one line: what it is called and the line that connects it.
 *
 * Everything else a card used to carry is gone — the description, whether it
 * opens a browser, who operates its OAuth client. None of it is lost: it is all
 * in `lanes link setup plan` and in the `setup_provider` capability, both of
 * which exist to answer "what does connecting this involve" at the length that
 * question deserves. This page answers a different one — what is there, and
 * what would I paste — and a paragraph per provider buried it.
 *
 * `plan.command` is built by the same `planFor` those two render, so the line
 * copied here and the line an agent suggests cannot drift.
 */
function providerCard(plan: ProviderPlan): string {
  return (
    '<div class="row">' +
    mark(plan.id) +
    `<span class="name">${escapeHtml(plan.name)}</span>` +
    copyButton(plan.command, plan.name) +
    '</div>'
  );
}

function catalogue(view: DashboardView): { available: string; another: string } {
  const plans = planAll(PROVIDER_MANIFESTS, {
    profile: view.profile,
    connections: view.connections.map((connection) => connection.key),
    ownClients: view.ownClients,
    target: view.target,
  });

  // The same split `setup_overview` makes: never connected is an invitation,
  // and already connected is only an invitation when a second account means
  // something (ADR — `multiAccount` is the credential test, not a preference).
  const available = plans.filter((plan) => plan.connected.length === 0);
  const more = plans.filter((plan) => plan.connected.length > 0 && plan.multiAccount);

  return {
    available: available.map(providerCard).join('\n'),
    another: more.map(providerCard).join('\n'),
  };
}

function switcher(view: DashboardView): string {
  // Links, not a form: choosing a profile here changes what this page shows and
  // nothing else. The workspace default is config, and config is written from
  // the CLI.
  const profiles = view.profiles
    .map((name) => {
      const current = name === view.profile;
      const label = escapeHtml(name);
      return current
        ? `<span class="chip on">${label}</span>`
        : `<a class="chip" href="?profile=${encodeURIComponent(name)}">${label}</a>`;
    })
    .join('');

  // Every declared target, with the one whose adapters are actually open marked.
  // The others are real — they are where `--target` would write — but nothing on
  // this page is reading from them.
  const targets = view.targets
    .map((name) =>
      name === view.target
        ? `<span class="chip on">${escapeHtml(name)}</span>`
        : `<span class="chip off" title="declared, but not the one this endpoint opened">${escapeHtml(name)}</span>`,
    )
    .join('');

  return (
    '<div class="switch">' +
    `<div class="group"><span class="eyebrow">profile</span>${profiles}</div>` +
    `<div class="group"><span class="eyebrow">target</span>${targets}</div>` +
    '</div>'
  );
}

export function dashboardPage(view: DashboardView): Response {
  const { available, another } = catalogue(view);

  const body =
    `<h1>Lanes Link</h1>${switcher(view)}` +
    `<h2 class="eyebrow">Connections</h2>${connectionsSection(view)}` +
    (available ? `<h2 class="eyebrow">Available</h2><div class="rows">${available}</div>` : '') +
    (another ? `<h2 class="eyebrow">Connect another account</h2><div class="rows">${another}</div>` : '') +
    '<h2 class="eyebrow">Elsewhere</h2>' +
    '<p class="empty">What is reachable, and what is wrong with it:</p>' +
    commandLine(command(view, 'status')) +
    commandLine(command(view, 'doctor'));

  return shell(body, 'Lanes Link', 200);
}

/**
 * What an unauthenticated browser gets.
 *
 * The narrow card rather than the wide page, because it is one sentence — and
 * it names the command instead of asking for the token, since the command is
 * what puts the token in the URL in the first place. A password field here
 * would be a second way in to guard for no benefit: whoever can run the command
 * is already whoever the token would prove them to be.
 *
 * The one command on this page carries neither `--profile` nor `--target`,
 * against the rule every other command here follows. Both are names, and this
 * page answers before authentication — ADR-018 stopped `/health` naming
 * profiles to an anonymous caller for exactly that reason, and a 401 that
 * recites the workspace's profile list would put it back.
 */
export function dashboardSignInPage(status: number): Response {
  return shell(
    '<div class="narrow"><h1>Not signed in</h1>' +
      '<p class="desc">This page opens from the terminal that is serving it.</p>' +
      commandLine('lanes link dashboard') +
      '</div>',
    'Lanes Link',
    status,
  );
}
