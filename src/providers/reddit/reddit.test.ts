import { describe, expect, test } from 'bun:test';
import { createHttpConnector } from '../../connectivity/transports/http/index.ts';
import { reddit } from './index.ts';
import { REDDIT_REDIRECT_URI, REDDIT_SCOPES } from './oauth.ts';
import { REDDIT_SCOPE_MEANINGS } from './scopes.ts';

/**
 * The spec beside this file is hand-authored, which is the whole reason these
 * tests exist. A vendored Google document is wrong only if Google is wrong;
 * this one is wrong if anybody mistyped a path, and nothing upstream would say
 * so. `cli/tools.test.ts` already checks the budgets and the redaction keys for
 * every `http` provider — what is here is what is particular to Reddit.
 */

const connector = reddit.connector as {
  kind: string;
  base_url: string;
  openapi: string;
  headers?: Record<string, string>;
};

async function capabilities() {
  return createHttpConnector({
    baseUrl: connector.base_url,
    openapi: connector.openapi,
    ...(connector.headers ? { headers: connector.headers } : {}),
  }).discover({ manifest: reddit } as never);
}

describe('the vendored spec becomes the capabilities it claims to', () => {
  test('every operation is discovered, and named without a redundant prefix', async () => {
    const names = (await capabilities()).map((c) => c.name).sort();

    expect(names).toEqual([
      'add_comment',
      'delete_thing',
      'edit_text',
      'get_post',
      'get_rules',
      'get_subreddit',
      'list_flairs',
      'list_my_subreddits',
      'list_posts',
      'save_thing',
      'search',
      'set_flair',
      'submit_post',
      'vote',
      'whoami',
    ]);
  });

  test('reads land in read and writes in write, decided by the verb alone', async () => {
    const byBundle = new Map((await capabilities()).map((c) => [c.name, c.bundle]));

    // What `connect` grants by default is the read bundle, so a write landing
    // in it would be granted silently. The split is derived from the HTTP
    // method rather than curated, which is what makes that safe — but only if
    // the spec uses the right verb, and this is where a GET on /api/submit
    // would show up.
    expect(byBundle.get('list_posts')).toBe('read');
    expect(byBundle.get('get_post')).toBe('read');
    expect(byBundle.get('search')).toBe('read');
    expect(byBundle.get('whoami')).toBe('read');
    expect(byBundle.get('submit_post')).toBe('write');
    expect(byBundle.get('add_comment')).toBe('write');
    expect(byBundle.get('vote')).toBe('write');
    expect(byBundle.get('delete_thing')).toBe('write');
  });

  test('the writes are form-encoded, because Reddit takes nothing else', async () => {
    // A JSON body is rejected outright, and the error names the missing
    // parameters rather than the encoding — so this failing looks like a bad
    // request rather than a wrong content type.
    const writes = (await capabilities()).filter((c) => c.bundle === 'write');
    expect(writes.length).toBeGreaterThan(0);

    for (const capability of writes) {
      const mapper = capability.target?.['mapper'] as { type: string; serialization?: { contentType?: string } }[];
      const body = mapper.filter((entry) => entry.type === 'body');

      expect(body.length).toBeGreaterThan(0);
      for (const entry of body) {
        expect(entry.serialization?.contentType).toBe('application/x-www-form-urlencoded');
      }
    }
  });
});

describe('what the manifest has to get exactly right', () => {
  test('the base url matches the spec server, or every call 404s', async () => {
    const spec = (await Bun.file(String(connector.openapi)).json()) as { servers: { url: string }[] };
    const server = spec.servers[0]?.url;

    expect(server).toBeTruthy();
    expect(connector.base_url).toBe(server!);
  });

  test('the grant is at www, the API at oauth — mixing them 404s', () => {
    const auth = reddit.auth as { authorize_url: string; token_url: string };
    expect(new URL(auth.authorize_url).host).toBe('www.reddit.com');
    expect(new URL(auth.token_url).host).toBe('www.reddit.com');
    expect(new URL(connector.base_url).host).toBe('oauth.reddit.com');
  });

  test('duration=permanent is asked for, or the connection dies after an hour', () => {
    // Reddit returns an access token and no refresh token without it. The
    // connection then works, and stops an hour later with nothing to point at.
    const auth = reddit.auth as { authorize_params?: Record<string, string> };
    expect(auth.authorize_params?.['duration']).toBe('permanent');
  });

  test('a refresh token is required, unlike Slack', () => {
    // Slack sets this to optional because a long-lived token and no refresh is
    // its successful answer. Here a missing one is the failure above.
    expect((reddit.auth as { refresh_token: string }).refresh_token).toBe('required');
  });

  test('the redirect names a port, since Reddit matches it exactly', () => {
    const auth = reddit.auth as { redirect_uri: string; broker?: unknown };
    expect(auth.redirect_uri).toBe(REDDIT_REDIRECT_URI);
    expect(new URL(auth.redirect_uri).port).not.toBe('');
    // Both would answer "where does the browser come back to", and the flow
    // reads one of them. `defineProvider` refuses the pair.
    expect(auth.broker).toBeUndefined();
  });

  test('a User-Agent is declared, because the default one is throttled hardest', () => {
    expect(connector.headers?.['User-Agent']).toBeTruthy();
    // Reddit's documented format ends with the author's handle. It is left out
    // on purpose — this repository refuses a real identifier anywhere a reader
    // can see, and the throttle looks for a descriptive name, not a person.
    expect(connector.headers?.['User-Agent']).not.toMatch(/\/u\//);
  });
});

describe('scopes are asked for in words, and only where something uses them', () => {
  test('every requested scope has a meaning to show before consent', () => {
    for (const scope of REDDIT_SCOPES) {
      expect(REDDIT_SCOPE_MEANINGS[scope]?.meaning).toBeTruthy();
    }
  });

  test('the three that act publicly as the person are marked broad', () => {
    expect(REDDIT_SCOPE_MEANINGS['submit']?.broad).toBe(true);
    expect(REDDIT_SCOPE_MEANINGS['edit']?.broad).toBe(true);
    expect(REDDIT_SCOPE_MEANINGS['vote']?.broad).toBe(true);
    // Not `read`: it reaches only what the account can already see, and what
    // Reddit makes readable is public to begin with.
    expect(REDDIT_SCOPE_MEANINGS['read']?.broad).toBeUndefined();
  });

  test('nothing is requested that no capability can spend', () => {
    // A scope on the consent screen that no tool uses is a grant asked for and
    // never spent, which is the thing least likely to be noticed later.
    const declared = new Set<string>(REDDIT_SCOPES);
    expect(declared.has('privatemessages')).toBe(false);
    expect(declared.has('history')).toBe(false);
    expect([...declared].some((s) => s.startsWith('mod'))).toBe(false);
  });
});

describe('what reaches the audit log when Reddit is written to', () => {
  test('a post records where it went and not what it said', () => {
    const kept = reddit.redact?.['submit_post'] ?? [];

    expect(kept).toContain('sr');
    expect(kept).toContain('flair_id');
    // A Reddit title is usually the whole of the post and the body is often
    // empty, so keeping it would defeat withholding the body.
    expect(kept).not.toContain('title');
    expect(kept).not.toContain('text');
    // For kind="link" the URL *is* the submission.
    expect(kept).not.toContain('url');
  });

  test('a comment records which thread and not the comment', () => {
    expect(reddit.redact?.['add_comment']).toEqual(['thing_id', 'api_type']);
    expect(reddit.redact?.['edit_text']).toEqual(['thing_id', 'api_type']);
  });

  test('every write has a redaction entry, so none defaults to withholding all', async () => {
    // The default withholds every value, which makes a write log useless: it
    // records that something changed without recording what. A new write
    // arriving with no entry is the silent version of that.
    const writes = (await capabilities()).filter((c) => c.bundle === 'write').map((c) => c.name);
    for (const name of writes) expect(reddit.redact?.[name]).toBeDefined();
  });
});
