import { fromJsonSchema } from '@modelcontextprotocol/server';
import { schemaFor } from './search-index.ts';
import { sanitizeSchema } from './schema.ts';
import type { MergedCapability } from './visibility.ts';

/**
 * Checking a call against what was advertised, before anything leaves.
 *
 * The typed tools have always had this and never needed a file for it: the SDK
 * compiles their input schema at registration and refuses a malformed call
 * itself. The gateway had nothing — its `arguments` is an open record — so the
 * same capability reached through it accepted anything, and a misspelled field
 * travelled to the vendor before anyone noticed. Under `surface: crunched`
 * every provider call takes that path, so it was every call.
 */

/**
 * Register the pair.
 *
 * Unconditionally, and ahead of the loop that registers what policy decided —
 * the same placement and the same argument as `lanes://instructions`. These
 * describe the surface rather than being part of it, and their whole value is
 * that a client which has fetched *any* tool list from this endpoint has them.
 * Registering them conditionally would put the one escape hatch from a stale
 * list behind the thing that goes stale.
 */
/**
 * Compiled validators, kept for as long as the server that built them.
 *
 * `buildMcpServer` runs per request, so this map lives exactly as long as one
 * request unless the caller reaches several capabilities in it. Compiling a
 * schema is not free — it is AJV code generation — and the alternative was
 * compiling on every call rather than every distinct capability.
 */
const compiled = new WeakMap<MergedCapability, ReturnType<typeof fromJsonSchema>>();

/**
 * Whether these arguments satisfy what was advertised, and what to say if not.
 *
 * Returns the refusal rather than throwing, because a refusal here is an
 * ordinary tool result the model is meant to read and act on.
 */
export function validate(
  capability: string,
  entry: MergedCapability,
  args: Record<string, unknown>,
): { content: { type: 'text'; text: string }[]; isError: true } | undefined {
  let schema = compiled.get(entry);
  if (schema === undefined) {
    try {
      schema = fromJsonSchema(sanitizeSchema(schemaFor(entry)) as never);
    } catch {
      // A schema that will not compile is still a callable capability, and
      // refusing every call to it would be a worse answer than the one the
      // vendor gives. This is the state the gateway was in for all of them.
      return undefined;
    }
    compiled.set(entry, schema);
  }

  const result = schema['~standard'].validate(args);
  if (result instanceof Promise) return undefined;
  if (result.issues === undefined) return undefined;

  const where = result.issues
    .map((issue) => {
      const path = (issue.path ?? [])
        .map((step) => (typeof step === 'object' ? String(step.key) : String(step)))
        .join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('\n');

  return {
    content: [
      {
        type: 'text' as const,
        text:
          `${capability} was not called: the arguments do not match its schema.\n\n${where}\n\n` +
          'This is what it accepts — correct the call and try again rather than searching for it ' +
          'again:\n```json\n' +
          `${JSON.stringify(schemaFor(entry), null, 2)}\n\`\`\``,
      },
    ],
    isError: true,
  };
}
