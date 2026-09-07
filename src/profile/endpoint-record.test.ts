import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearEndpointRecord,
  readEndpointRecord,
  writeEndpointRecord,
} from './endpoint-record.ts';

/**
 * Where the endpoint is, according to the endpoint.
 *
 * The property under test is not that a file round-trips. It is that **a record
 * nobody cleaned up cannot send a notify to the wrong place.** One endpoint
 * serves a whole workspace, so this file is the only thing that knows which
 * port that is — and a command acting on it is about to POST `/reload` at
 * whatever this says. A crashed endpoint, a reused pid and a half-written file
 * all have to answer null rather than an address.
 */

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'lanes-link-endpoint-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('a live record', () => {
  test('round-trips the url and the profiles it covers', async () => {
    const root = await workspace();
    await writeEndpointRecord(root, {
      url: 'http://127.0.0.1:7451/mcp',
      profiles: ['personal', 'work'],
    });

    const record = await readEndpointRecord(root);
    expect(record?.url).toBe('http://127.0.0.1:7451/mcp');
    expect(record?.profiles).toEqual(['personal', 'work']);
    // This process wrote it, so this process is what it names.
    expect(record?.pid).toBe(process.pid);
  });

  test('is not readable by anybody but its owner', async () => {
    const root = await workspace();
    await writeEndpointRecord(root, { url: 'http://127.0.0.1:7337/mcp', profiles: ['personal'] });

    const { mode } = await import('node:fs/promises').then((fs) =>
      fs.stat(join(root, 'endpoint.json')),
    );
    expect(mode & 0o777).toBe(0o600);
  });
});

describe('a record that cannot be trusted answers nothing', () => {
  test('a workspace that has never served answers null', async () => {
    expect(await readEndpointRecord(await workspace())).toBeNull();
  });

  test('a dead pid answers null, not an address', async () => {
    // The case that makes this safe to leave lying around. A `kill -9` skips
    // the shutdown that clears it, so the file outlives the listener — and the
    // address it names is one nothing has answered on since. Returning it would
    // send every notify in the workspace somewhere it cannot be heard, and
    // report "no endpoint answered" for an endpoint that is not there, which is
    // exactly the behaviour that existed before the record — except now it
    // would also be *wrong* about a workspace whose endpoint had moved.
    const root = await workspace();
    await writeFile(
      join(root, 'endpoint.json'),
      JSON.stringify({
        url: 'http://127.0.0.1:7451/mcp',
        // Above the pid ceiling on every platform this runs on, so it cannot be
        // a process that happens to exist while the test runs.
        pid: 0x7fffffff,
        profiles: ['personal'],
        startedAt: new Date().toISOString(),
      }),
    );

    expect(await readEndpointRecord(root)).toBeNull();
  });

  test('a half-written file answers null rather than throwing', async () => {
    // Reachable: `start` writes this while other commands are running, and a
    // reader that threw would fail an edit over a file that exists only to make
    // one land faster.
    const root = await workspace();
    await writeFile(join(root, 'endpoint.json'), '{"url": "http://127.0.0.1:74');

    expect(await readEndpointRecord(root)).toBeNull();
  });

  test('a record missing the one field it is for answers null', async () => {
    const root = await workspace();
    await writeFile(join(root, 'endpoint.json'), JSON.stringify({ pid: process.pid }));

    expect(await readEndpointRecord(root)).toBeNull();
  });
});

describe('clearing it', () => {
  test('removes the file, and does not mind being run twice', async () => {
    const root = await workspace();
    await writeEndpointRecord(root, { url: 'http://127.0.0.1:7337/mcp', profiles: ['personal'] });
    expect(existsSync(join(root, 'endpoint.json'))).toBe(true);

    await clearEndpointRecord(root);
    expect(existsSync(join(root, 'endpoint.json'))).toBe(false);

    // A shutdown that races another shutdown, or one that runs after a crash
    // already took the file with it.
    await clearEndpointRecord(root);
    expect(await readEndpointRecord(root)).toBeNull();
  });
});

describe('a remote workspace has no record at all', () => {
  test('nothing is written for a bucket, and nothing is read back', async () => {
    // A deployed target's address belongs to the platform, which knows it
    // authoritatively — and ADR-007 says a revision never writes its own
    // configuration. Writing this into the bucket would be a revision
    // announcing itself into the files it is forbidden to touch.
    await writeEndpointRecord('gs://bucket-name', {
      url: 'https://service.example.com/mcp',
      profiles: ['personal'],
    });

    expect(await readEndpointRecord('gs://bucket-name')).toBeNull();
    await clearEndpointRecord('gs://bucket-name');
  });
});

describe('the record is written where the layout says', () => {
  test('at the workspace root, beside the config it is not part of', async () => {
    const root = await workspace();
    await writeEndpointRecord(root, { url: 'http://127.0.0.1:7337/mcp', profiles: ['personal'] });

    const written = JSON.parse(await readFile(join(root, 'endpoint.json'), 'utf8')) as {
      url: string;
    };
    expect(written.url).toBe('http://127.0.0.1:7337/mcp');
  });
});
