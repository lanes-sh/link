import { describe, expect, test } from 'bun:test';
import { projectRequestBody } from './vendor-operations.ts';

/**
 * What `projectRequestBody` promises, held to it.
 *
 * The bug it was written for was a schema that described a call the vendor
 * would refuse, and what let that ship was a claim nothing checked. Its own
 * docstring now makes four promises to refuse rather than guess, and a refusal
 * that does not fire is the same kind of claim — so each one is exercised here
 * against a spec fragment rather than asserted in a comment.
 */

const schemas = (): Record<string, unknown> => ({
  Draft: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'The status of the Draft.' },
      entries: { type: 'array', items: {} },
      id: { type: 'integer', readOnly: true },
    },
    required: ['entries'],
  },
});

const operation = (schema: unknown = { $ref: '#/components/schemas/Draft' }): Record<string, unknown> => ({
  operationId: 'UPDATE_Draft',
  requestBody: { content: { 'application/json': { schema } } },
});

const body = (op: Record<string, unknown>): Record<string, unknown> => {
  const content = (op['requestBody'] as { content: Record<string, { schema: Record<string, unknown> }> })
    .content;
  return content['application/json']!.schema;
};

describe('projectRequestBody', () => {
  test('keeps the vendor’s own type and description, and asserts the caller’s required', () => {
    const op = operation();
    projectRequestBody(op, 'UPDATE_Draft', schemas(), ['status'], 'Only this.');

    expect(body(op)).toEqual({
      type: 'object',
      description: 'Only this.',
      properties: { status: { type: 'string', description: 'The status of the Draft.' } },
      required: ['status'],
    });
    // The projection replaces the reference outright: `entries` was required by
    // the schema this used to point at, and that is the whole disease.
    expect(JSON.stringify(body(op))).not.toContain('entries');
  });

  test('refuses a field the vendor no longer describes', () => {
    // A rename upstream must fail the refresh. Skipping the field instead would
    // publish a narrower tool; leaving the body alone would restore the wide one.
    expect(() => projectRequestBody(operation(), 'UPDATE_Draft', schemas(), ['gone'], '')).toThrow(
      /no longer describes "gone"/,
    );
  });

  test('refuses a read-only field', () => {
    // Projected fields are inlined into the path, where the read-only strip does
    // not reach — so this would become a required argument the vendor ignores.
    expect(() => projectRequestBody(operation(), 'UPDATE_Draft', schemas(), ['id'], '')).toThrow(
      /read-only/,
    );
  });

  test('refuses a body offering a content type it does not rewrite', () => {
    const op = operation();
    (op['requestBody'] as { content: Record<string, unknown> }).content['application/xml'] = {
      schema: { $ref: '#/components/schemas/Draft' },
    };

    // Narrowing one branch and leaving the other wide makes the fix depend on
    // which branch the generator prefers, which is a third party's choice.
    expect(() => projectRequestBody(op, 'UPDATE_Draft', schemas(), ['status'], '')).toThrow(
      /application\/xml/,
    );
  });

  test('refuses a reference that does not point into components.schemas', () => {
    // Otherwise the pointer survives `slice` unchanged, no schema is found, and
    // the error blames a renamed field for what is a different problem.
    const op = operation({ $ref: '#/components/requestBodies/Draft' });

    expect(() => projectRequestBody(op, 'UPDATE_Draft', schemas(), ['status'], '')).toThrow(
      /not a schema reference/,
    );
  });
});
