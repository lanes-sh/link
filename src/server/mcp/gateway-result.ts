import type { ToolResult } from '#connectivity';
import { toolNameFor } from './naming.ts';

/**
 * What `lanes_tools_call` hands back.
 *
 * Its own file for the reason `transports/mcp/result.ts` gives on the other
 * side of the same question: `search.ts` registers two tools and routes a call,
 * and shaping what comes back out is a different subject that had grown to a
 * paragraph of its own. The two files are deliberately a pair — one decides
 * what an upstream's answer becomes on the way in, this one what a capability's
 * answer becomes on the way out through the gateway.
 *
 * Text only, unlike `makeHandler`. A `resource_link` has to be rewritten
 * through `resourceLinkRouter` to carry the profile and connection it was
 * produced under, and a link is a follow-up call the caller makes against a
 * *typed* resource tool — so a caller reaching a capability through here gets
 * the text and is told to use the named tool for the rest.
 */
export function handedBackByGateway(
  result: ToolResult,
  options: { readonly crunched: boolean; readonly capabilityId: string },
): { content: { type: 'text'; text: string }[]; isError?: boolean } {
  // Under `crunched` there is no named tool to be told about, so the message
  // says what is actually true rather than naming one the client cannot call.
  // This is the one thing the mode genuinely costs, and it is recorded in
  // ADR-076 rather than papered over.
  const linkAdvice = options.crunched
    ? 'this endpoint does not advertise its typed tools, so the resource link cannot be handed back through here'
    : `call ${toolNameFor(options.capabilityId)} directly to receive this as a resource link`;

  const content = result.content.map((block) =>
    block.type === 'text'
      ? { type: 'text' as const, text: block.text }
      : { type: 'text' as const, text: `[${block.name ?? block.uri}] — ${linkAdvice}.` },
  );

  // A tool may answer as data, and repeating it as text is a SHOULD rather than
  // a MUST — so an upstream that declines leaves the records only in
  // `structuredContent`, and mapping `content` alone dropped them. With no
  // text at all that produced an empty result which was not an error, reading
  // as "the tool had nothing to say"; with a sentence of prose beside the data
  // it was quieter and worse, because "Found 12 issues." looks like a complete
  // answer and the twelve were gone. This tool declares no output schema and
  // hands back text, so the data is rendered rather than passed through.
  //
  // Under `crunched` every provider call arrives here, so this is the path it
  // matters most on and the one a unit test is least likely to cover.
  if (result.structuredContent !== undefined) {
    // Compared as values, not as bytes. A server following the SHOULD serialises
    // the same data its own way — compact where this renders indented — so a
    // byte-for-byte check misses the case it exists for and the caller gets the
    // whole payload twice. That was measured against a real vendor: the answer
    // came back duplicated, and under `crunched` every provider call arrives
    // here, so it is a doubling of the common case rather than an edge.
    //
    // Parsing each text block is cheap beside the call that produced it, and a
    // block that is not JSON simply does not match. Key order is not
    // normalised: both sides came from the same upstream, so it agrees in
    // practice, and disagreeing errs toward sending the data — which is the
    // safe direction, since the failure it guards against is losing it.
    const data = JSON.stringify(result.structuredContent);
    const alreadySent = content.some((block) => {
      try {
        return JSON.stringify(JSON.parse(block.text)) === data;
      } catch {
        return false;
      }
    });

    if (!alreadySent) {
      content.push({ type: 'text' as const, text: JSON.stringify(result.structuredContent, null, 2) });
    }
  }

  return { content, ...(result.isError ? { isError: true } : {}) };
}
