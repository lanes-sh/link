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

const silent: Prompter = {
  interactive: false,
  ask: async () => '',
  askSecret: async () => '',
  confirm: async () => false,
};

function runtime(
  connections: readonly ConnectionConfig[] = [],
  identity: string | null = 'ada@example.com',
) {
  return {
    config: { grants: [] } as unknown as Config,
    // The accounts are the workspace's now (ADR-057), and sibling matching reads
    // them from there rather than from the profile being connected into.
    workspaceConnections: connections,
    credentials: memoryStore(),
    registry: { manifest: () => undefined },
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
  test('is asked for every time, offering the account that was just resolved', async () => {
    const asking = prompter('');

    const settled = await settle({ prompter: asking });

    expect(asking.asked).toHaveLength(1);
    // The account is in the question, so pressing Enter is an informed answer
    // rather than a blank one.
    expect(asking.asked[0]).toContain('ada@example.com');
    expect(settled.label).toBe('ada@example.com');
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

  test('falls back to the account where there is nobody to ask', async () => {
    const settled = await settle({ prompter: silent });

    expect(settled.label).toBe('ada@example.com');
  });

  test('is not asked for when it was given', async () => {
    const asking = prompter('ignored');

    const settled = await settle({ prompter: asking, label: 'Work mail' });

    expect(asking.asked).toHaveLength(0);
    expect(settled.label).toBe('Work mail');
  });

  test('takes the account when the terminal it was promised turns out not to exist', async () => {
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

    expect(settled.label).toBe('ada@example.com');
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
    expect(settled.label).toBe('Ada at Acme');
  });
});
