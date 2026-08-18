import { describe, expect, test } from 'bun:test';
import type { AuditDraft } from '#audit';
import { createOtlpAuditSink } from './otlp.ts';

const draft: AuditDraft = {
  profile: 'personal',
  principal: 'personal:owner',
  provider: 'gmail',
  connection: 'gmail.main',
  capability: 'gmail.send_message',
  arguments: { to: '<string:18>' },
  authorization: 'allowed',
  status: 'ok',
  durationMs: 412,
};

/** Capture the one request the sink makes. */
function capturing(response = new Response(null, { status: 200 })) {
  const sent: Array<{ url: string; init: RequestInit | undefined }> = [];
  return {
    sent,
    fetch: async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: url.toString(), init });
      return response;
    },
    body: () => JSON.parse(sent[0]!.init!.body as string) as Record<string, never>,
    record: () => {
      const payload = JSON.parse(sent[0]!.init!.body as string);
      return payload.resourceLogs[0].scopeLogs[0].logRecords[0];
    },
    attribute: (key: string) => {
      const payload = JSON.parse(sent[0]!.init!.body as string);
      const found = payload.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.find(
        (attribute: { key: string }) => attribute.key === key,
      );
      return found?.value?.stringValue ?? found?.value?.intValue;
    },
  };
}

describe('otlp audit sink', () => {
  const at = new Date('2026-08-12T10:04:31.221Z');

  test('posts one OTLP log record as JSON', async () => {
    const http = capturing();
    await createOtlpAuditSink({
      endpoint: 'https://collector.example/v1/logs',
      now: () => at,
      fetch: http.fetch,
    }).append(draft);

    expect(http.sent[0]?.url).toBe('https://collector.example/v1/logs');
    expect(new Headers(http.sent[0]?.init?.headers).get('content-type')).toBe('application/json');
    expect(http.record().body.stringValue).toBe('gmail.send_message');
  });

  test('the timestamp is nanoseconds as a string', () => {
    // fixed64 in the spec. A millisecond timestamp times a million is past
    // 2^53, so a JSON number would round it and every record would land at the
    // same nanosecond-ish instant.
    const http = capturing();
    return createOtlpAuditSink({
      endpoint: 'https://c/v1/logs',
      now: () => at,
      fetch: http.fetch,
    })
      .append(draft)
      .then(() => {
        expect(http.record().timeUnixNano).toBe('1786529071221000000');
        expect(typeof http.record().timeUnixNano).toBe('string');
      });
  });

  test('a denial is a warning and a failure is an error', async () => {
    for (const [input, expected] of [
      [draft, 'INFO'],
      [{ ...draft, authorization: 'denied_by_policy' as const }, 'WARN'],
      [{ ...draft, status: 'error' as const }, 'ERROR'],
    ] as const) {
      const http = capturing();
      await createOtlpAuditSink({ endpoint: 'https://c/v1/logs', fetch: http.fetch }).append(input);
      expect(http.record().severityText).toBe(expected);
    }
  });

  test('static headers are sent', async () => {
    const http = capturing();
    await createOtlpAuditSink({
      endpoint: 'https://c/v1/logs',
      headers: { 'x-api-key': 'abc' },
      fetch: http.fetch,
    }).append(draft);

    expect(new Headers(http.sent[0]?.init?.headers).get('x-api-key')).toBe('abc');
  });

  test('arguments travel already redacted, serialised', async () => {
    // Redaction happens before any sink sees the event — a provider declares
    // what survives and the default keeps no values. This asserts the sink
    // does not undo that by reaching past what it was handed.
    const http = capturing();
    await createOtlpAuditSink({ endpoint: 'https://c/v1/logs', fetch: http.fetch }).append(draft);

    expect(http.attribute('lanes.arguments')).toBe('{"to":"<string:18>"}');
  });

  test('a rejected send raises, so the fan-out can report it', async () => {
    const http = capturing(new Response('bad tenant', { status: 401 }));
    const sink = createOtlpAuditSink({ endpoint: 'https://c/v1/logs', fetch: http.fetch });

    await expect(sink.append(draft)).rejects.toThrow(/401.*bad tenant/s);
  });
});
