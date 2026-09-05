import { describe, expect, test } from 'bun:test';
import { defineProvider } from '#connectivity';
import type { ConnectionConfig, Config } from '#profile';
import type { AnyConnector, ProviderManifest } from '#connectivity';
import type { SecretRef, SecretStore } from '#secrets';
import { PromptCancelled, type Prompter } from '../../prompt.ts';
import { settleIdentity } from './settle.ts';

/**
 * What a connection is *called*, as distinct from whose account it is.
 *
 * `account` is load-bearing — it decides whether a second `connect` repairs the
 * row or appends `main2`, it derives the id, and `gmail.send_message` writes it
 * into a `From` header. So the operator's own words for a connection cannot go
 * there, and until `label` existed there was nowhere else to put them: `relabel`
 * overwrote the identity, and the next reconnect no longer recognised it.
 *
 * The prompt is unconditional on purpose. It used to appear only when identity
 * resolution had failed, which is the one case where the operator has nothing to
 * confirm and the least to say — so the question arrived exactly when it was
 * least useful and never when it was.
 */

const acme = defineProvider({
  id: 'acme_mail',
  name: 'Acme Mail',
  connector: {
    kind: 'imap',
    host: 'imap.acme.test',
    port: 993,
    smtp: { host: 'smtp.acme.test', port: 587, starttls: true },
  },
  auth: { kind: 'basic', app: 'acme' },
  identity: { kind: 'connector' },
  setup: {
    prompts: [
      {
        key: 'username',
        label: 'Address',
        scope: 'connection' as const,
        field: 'username' as const,
      },
      {
        key: 'password',
        label: 'Password',
        secret: true,
        scope: 'connection' as const,
        field: 'password' as const,
      },
    ],
  },
});

/** The same provider with nothing to ask about identity — the fallback path. */
const anonymous: ProviderManifest = { ...acme, identity: undefined };

function memoryStore(): SecretStore {
  const map = new Map<string, string>();
  return {
    get: async (ref) => map.get(ref) ?? null,
    set: async (ref, value) => void map.set(ref, value),
    has: async (ref) => map.has(ref),
    delete: async (ref) => void map.delete(ref),
    list: async (prefix) =>
      [...map.keys()].filter((k) => !prefix || k.startsWith(prefix)) as SecretRef[],
  };
}

/** A terminal that answers whatever it was handed, and records being asked. */
function prompter(answer = ''): Prompter & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return answer;
    },
    askSecret: async () => answer,
    confirm: async () => true,
  };
}

/** A terminal that works through a script of answers, then answers nothing. */
function scripted(...answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  let next = 0;

  return {
    asked,
    interactive: true,
    ask: async (question) => {
      asked.push(question);
      return answers[next++] ?? '';
    },
    askSecret: async () => '',
    confirm: async () => true,
  };
}

const silent: Prompter = {
  interactive: false,
  ask: async () => '',
  askSecret: async () => '',
  confirm: async () => false,
};

function runtime(
  connections: readonly ConnectionConfig[] = [],
  identity: string | null = 'ada@example.com',
  /**
   * What the registry knows, for the sibling half of the match.
   *
   * Empty by default, which is what every test asserting one provider wants —
   * `accountSiblings` then answers from the provider id alone. A test about a
   * *vendor* has to fill it in: `app: 'acme'` is a manifest field, so two
   * providers are one account only if the registry can be asked.
   */
  known: readonly ProviderManifest[] = [],
) {
  return {
    config: { grants: [] } as unknown as Config,
    // The accounts are the workspace's now (ADR-057), and sibling matching reads
    // them from there rather than from the profile being connected into.
    workspaceConnections: connections,
    credentials: memoryStore(),
    registry: { manifest: (id: string) => known.find((candidate) => candidate.id === id) },
    connectorFor: () =>
      (identity === null ? undefined : { identify: async () => identity }) as
        | AnyConnector
        | undefined,
    authorizeRequest: async (_provider: string, _connection: string, request: Request) => request,
  };
}

const settle = (over: Partial<Parameters<typeof settleIdentity>[0]> = {}) =>
  settleIdentity({
    manifest: acme,
    provisionalId: 'pending',
    explicitId: undefined,
    account: undefined,
    runtime: runtime(),
    ...over,
  });

describe('the label a connection is given at connect time', () => {
  test('is asked for every time, offering the provider and the account', async () => {
    const asking = prompter('');

    const settled = await settle({ prompter: asking });

    expect(asking.asked).toHaveLength(1);
    // The suggestion is in the question, so pressing Enter is an informed
    // answer rather than a blank one. It names the provider as well as the
    // account, because the account alone was a second copy of the line beside
    // it and left every reader of an unlabelled row with nothing to show.
    expect(asking.asked[0]).toContain('Acme Mail (ada)');
    expect(settled.label).toBe('Acme Mail (ada)');
    expect(settled.defaultLabel).toBe('Acme Mail (ada)');
  });

  test('takes the operator words, and leaves the account they replace alone', async () => {
    const settled = await settle({ prompter: prompter('Work mail') });

    expect(settled.label).toBe('Work mail');
    // The account is what the reconnect match is built from, and it is unmoved
    // by a label. The id is no longer built from anything — it is allocated,
    // which is what stops a relabel ever moving a credential ref.
    expect(settled.account).toBe('ada@example.com');
    expect(settled.connectionId).toBe('con1');
  });

  test('offers the label already on the row when this connect is a reconnect', async () => {
    const declared = [
      { id: 'ada', provider: 'acme_mail', account: 'ada@example.com', label: 'Work mail' },
    ] as ConnectionConfig[];
    const asking = prompter('');

    const settled = await settle({ prompter: asking, runtime: runtime(declared) });

    // Not the account: re-authorising an expired credential must not silently
    // undo the name the operator chose.
    expect(asking.asked[0]).toContain('Work mail');
    expect(settled.label).toBe('Work mail');
    expect(settled.connectionId).toBe('ada');
  });

  test('falls back to the derived name where there is nobody to ask', async () => {
    const settled = await settle({ prompter: silent });

    expect(settled.label).toBe('Acme Mail (ada)');
  });

  test('is not asked for when it was given', async () => {
    const asking = prompter('ignored');

    const settled = await settle({ prompter: asking, label: 'Work mail' });

    expect(asking.asked).toHaveLength(0);
    expect(settled.label).toBe('Work mail');
  });

  test('takes the derived name when the terminal it was promised turns out not to exist', async () => {
    // `terminalPrompter` says `interactive: true` and discovers otherwise only
    // when asked. By then the browser has opened and the credential is stored,
    // so throwing over a display name fails a connect that has already happened.
    const noTerminal: Prompter = {
      interactive: true,
      ask: async () => {
        throw new Error('This command needs an interactive terminal to collect credentials.');
      },
      askSecret: async () => '',
      confirm: async () => false,
    };

    const settled = await settle({ prompter: noTerminal });

    expect(settled.label).toBe('Acme Mail (ada)');
  });

  test('lets Ctrl-C stop the command rather than answering for it', async () => {
    const cancelling: Prompter = {
      interactive: true,
      ask: async () => {
        throw new PromptCancelled();
      },
      askSecret: async () => '',
      confirm: async () => false,
    };

    expect(settle({ prompter: cancelling })).rejects.toThrow(PromptCancelled);
  });

  test('costs one question, not two, when the provider cannot say whose account it is', async () => {
    const asking = prompter('Ada at Acme');

    const settled = await settle({
      manifest: anonymous,
      prompter: asking,
      runtime: runtime([], null),
    });

    // The operator has already typed the only name there is. Asking them to
    // confirm it against itself is the second half of a question they answered.
    expect(asking.asked).toHaveLength(1);
    expect(settled.account).toBe('Ada at Acme');
    expect(settled.label).toBe('Acme Mail (Ada at Acme)');
  });
});

/**
 * The account question, when there is nothing to answer it with.
 *
 * An empty answer used to be taken and stored `Acme Mail pending` — the
 * provider's name beside the *provisional* connection id, an internal token
 * meaning "no id yet". That string then became the account, the default label,
 * and the key a reconnect matches on. Nobody chose it, and a row named after it
 * can answer none of the questions an account exists to answer.
 */
describe('an account nobody could report', () => {
  const unnamable = { manifest: anonymous, runtime: runtime([], null) };

  test('re-asks rather than taking silence for an answer', async () => {
    const asking = scripted('', '', 'ada@example.com');

    const settled = await settle({ ...unnamable, prompter: asking });

    expect(asking.asked).toHaveLength(3);
    expect(settled.account).toBe('ada@example.com');
  });

  test('takes "blank" from someone who meant it, and says so honestly', async () => {
    const asking = scripted('', 'blank');

    const settled = await settle({ ...unnamable, prompter: asking });

    // Not `Acme Mail pending`. `unnamed` is visibly not an address, and reads
    // through `defaultConnectionLabel` as a name rather than an internal token.
    expect(settled.account).toBe('unnamed');
    expect(settled.label).toBe('Acme Mail (unnamed)');
  });

  test('and does not match a row that was also left unnamed', async () => {
    // `unnamed` is not an identity, so two of them are not evidence of one
    // account. Matching them would hand the second connect the first row's
    // credential ref and overwrite it; a fresh id says the only true thing
    // available, which is that these are two rows.
    const declared = [
      { id: 'con1', provider: 'acme_mail', account: 'unnamed' },
    ] as ConnectionConfig[];

    const settled = await settle({
      manifest: anonymous,
      runtime: runtime(declared, null),
      prompter: scripted('blank'),
    });

    expect(settled.connectionId).toBe('con2');
  });

  test('refuses in the end rather than asking forever', async () => {
    // A prompter that reports itself interactive and returns nothing forever is
    // not hypothetical — a closed pipe does it — and a connect that hangs is
    // worse than one that refuses in the words the non-interactive path uses.
    const asking = scripted();

    expect(settle({ ...unnamable, prompter: asking })).rejects.toThrow(/Nothing was written/);
  });
});

/**
 * The other half of one vendor account.
 *
 * A second provider declaring the same `app`, which is what makes the two one
 * Apple Account rather than two: `credentialApp` reads the manifest field, so
 * `acme_calendar` and `acme_mail` derive `acme/<id>` and share a password.
 */
const acmeCalendar: ProviderManifest = { ...acme, id: 'acme_calendar', name: 'Acme Calendar' };

const vendor = [acme, acmeCalendar];

describe('connecting an account this provider already holds', () => {
  test('lands on its own row rather than a sibling that shares the account', async () => {
    // The reported shape: three services on one Apple Account whose ids had
    // drifted apart, the calendar written first. Matching the account across
    // the vendor found the calendar, settled on `con3`, and left the mail row
    // at `con5` stale while a second one was appended beside it.
    const declared = [
      { id: 'con3', provider: 'acme_calendar', account: 'ada@example.com' },
      { id: 'con5', provider: 'acme_mail', account: 'ada@example.com' },
    ] as ConnectionConfig[];

    const settled = await settle({ prompter: silent, runtime: runtime(declared, undefined, vendor) });

    expect(settled.connectionId).toBe('con5');
  });

  test('adopts a sibling id where this provider has no row for the account', async () => {
    // The reason the sibling half of the match exists, and it has to survive
    // the fix: one authorisation for a vendor is one id across its services,
    // which is what makes them share the one password rather than ask for it
    // once per service.
    const declared = [
      { id: 'con3', provider: 'acme_calendar', account: 'ada@example.com' },
    ] as ConnectionConfig[];

    const settled = await settle({ prompter: silent, runtime: runtime(declared, undefined, vendor) });

    expect(settled.connectionId).toBe('con3');
  });

  test('recognises the account through case and surrounding space', async () => {
    // Nothing trims on the way in, so a probe that answers with a space around
    // the address writes one — and a row nothing can match again is a row the
    // next connect duplicates.
    const declared = [
      { id: 'con5', provider: 'acme_mail', account: '  Ada@Example.com ' },
    ] as ConnectionConfig[];

    const settled = await settle({ prompter: silent, runtime: runtime(declared, undefined, vendor) });

    expect(settled.connectionId).toBe('con5');
  });

  test('offers its own label, not the one a sibling sharing the id carries', async () => {
    // An id is shared across a vendor by design, so looking a label up by id
    // alone answers with whichever service is written first.
    const declared = [
      {
        id: 'con3',
        provider: 'acme_calendar',
        account: 'ada@example.com',
        label: 'Family calendar',
      },
      { id: 'con3', provider: 'acme_mail', account: 'ada@example.com', label: 'Work mail' },
    ] as ConnectionConfig[];
    const asking = prompter('');

    const settled = await settle({ prompter: asking, runtime: runtime(declared, undefined, vendor) });

    expect(settled.connectionId).toBe('con3');
    expect(asking.asked[0]).toContain('Work mail');
    expect(settled.label).toBe('Work mail');
  });
});

/**
 * A surface that authenticates to nothing: the owner layer's shape.
 *
 * There is no account to ask about, so `settleIdentity` names it after the
 * provider and takes an `lan` id rather than a `con` one.
 */
const unauthenticated: ProviderManifest = {
  ...acme,
  auth: { kind: 'none' },
  identity: undefined,
};

describe('connecting a surface that has no account to name', () => {
  const settleUnauthenticated = (declared: readonly ConnectionConfig[]) =>
    settle({
      manifest: unauthenticated,
      prompter: silent,
      runtime: runtime(declared, null),
    });

  test('takes a fresh owner id the first time', async () => {
    expect((await settleUnauthenticated([])).connectionId).toBe('lan1');
  });

  test('lands on the row it already has rather than a second one', async () => {
    // Its account is the provider's own name, so every connect of it resolves
    // the same string and there is never a second one to describe. Allocating
    // regardless made `connect example` twice into `lan8` and `lan9` — one
    // surface, two rows, the same duplicate the vendor case produced.
    const declared = [
      { id: 'lan8', provider: 'acme_mail', account: 'Acme Mail' },
    ] as ConnectionConfig[];

    expect((await settleUnauthenticated(declared)).connectionId).toBe('lan8');
  });
});
