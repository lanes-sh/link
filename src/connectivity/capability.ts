import type { z } from 'zod';
import type { RedactionRule } from '#audit';
import type { ProviderContext } from './context.ts';

/**
 * A capability is one tool, resource, or prompt a provider exposes.
 *
 * Do not make everything a tool. Use resources for read-oriented document or
 * structured context, tools for actions and parameterised queries, prompts for
 * reusable procedures. Decide per capability and record the reasoning in
 * `https://lanes.sh/docs/link/capabilities` — ADR-006.
 */
export type Capability = ToolCapability | ResourceCapability | PromptCapability;

export interface CapabilityBase {
  /**
   * Unqualified name, e.g. `search`. Core qualifies it as `<provider>.<name>`
   * — `gmail.search` — and that qualified form is what policy rules and audit
   * events reference.
   */
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  /**
   * What survives into the audit log. Defaults to recording argument names and
   * value types but no values, because a search query routinely contains the
   * very content the caller may not be allowed to read.
   *
   * On the base rather than on tools alone: a resource read is dispatched with
   * its URI as an argument, and a memory address is exactly as worth recording
   * — and exactly as worth withholding — as a message id.
   */
  readonly redact?: RedactionRule;
}

export type ToolResult = {
  readonly content: ReadonlyArray<
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'resource_link'; readonly uri: string; readonly name?: string }
  >;
  readonly isError?: boolean;
};

export interface ToolCapability<Schema extends z.ZodType = z.ZodType> extends CapabilityBase {
  readonly kind: 'tool';
  /**
   * The provider's own arguments only.
   *
   * Do NOT declare a `connection` argument. Core injects it, populates its enum
   * per profile from resolved policy, and resolves it to a `ConnectionInfo`
   * before the handler runs — so a client cannot even discover connections it
   * has no grant for. That is ADR-001, and keeping it out of provider code is
   * what makes one tool set scale to any number of accounts.
   */
  readonly inputSchema: Schema;
  handler(input: z.infer<Schema>, context: ProviderContext): Promise<ToolResult>;
}

export interface ResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text: string;
}

/**
 * Read-oriented context addressed by a stable identifier — ADR-006.
 *
 * Both operations are reached through the same dispatch path tools use, so a
 * resource read is policy-checked and audited exactly like a tool call. Core
 * selects between them by whether it passes a `uri` argument: present means
 * `read`, absent means `list`. Providers never see that distinction; they
 * implement two methods.
 */
export interface ResourceCapability extends CapabilityBase {
  readonly kind: 'resource';
  /** RFC 6570 style, e.g. `example://notes/{id}`. A fixed URI is also valid. */
  readonly uriTemplate: string;
  readonly mimeType?: string;
  /** Enumerate concrete resources. Omit when the space is unbounded. */
  list?(context: ProviderContext): Promise<ReadonlyArray<{ uri: string; name: string }>>;
  read(
    uri: string,
    params: Readonly<Record<string, string>>,
    context: ProviderContext,
  ): Promise<ResourceContents>;
}

/**
 * A reusable procedure — the `skills` provider, and nothing else so far.
 *
 * The shape was fixed in M1 and left unimplemented so the primitive could not
 * be claimed by anything else in the meantime; M4 gave it a runtime path.
 */
export interface PromptCapability extends CapabilityBase {
  readonly kind: 'prompt';
  readonly arguments?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly required?: boolean;
  }>;
  render(args: Readonly<Record<string, string>>, context: ProviderContext): Promise<PromptResult>;
}

export interface PromptMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface PromptResult {
  readonly messages: ReadonlyArray<PromptMessage>;
}

/** What `ResourceCapability.read` produced, as dispatch hands it back. */
export interface ResourceResult {
  readonly contents: ReadonlyArray<ResourceContents>;
}

/** What `ResourceCapability.list` produced. */
export interface ResourceListResult {
  readonly resources: ReadonlyArray<{ readonly uri: string; readonly name: string }>;
}

/**
 * What one invocation produced, whichever primitive it was.
 *
 * A union rather than a widened `ToolResult` so that every existing connector —
 * `http`, `mcp`, `imap`, `dav`, all of which serve tools only — keeps compiling
 * unchanged: `ToolResult` is still a member, so their return type still
 * satisfies `Connector.invoke`.
 *
 * Discriminated by which key is present, and the four keys are deliberately
 * checked through the guards below rather than by hand. `content` and
 * `contents` differ by one letter, and getting that wrong reads as an empty
 * result rather than as a type error.
 */
export type CapabilityResult = ToolResult | ResourceResult | ResourceListResult | PromptResult;

export function isToolResult(result: CapabilityResult): result is ToolResult {
  return 'content' in result;
}

export function isResourceResult(result: CapabilityResult): result is ResourceResult {
  return 'contents' in result;
}

export function isResourceListResult(result: CapabilityResult): result is ResourceListResult {
  return 'resources' in result;
}

export function isPromptResult(result: CapabilityResult): result is PromptResult {
  return 'messages' in result;
}

export function isTool(capability: Capability): capability is ToolCapability {
  return capability.kind === 'tool';
}

export function isResource(capability: Capability): capability is ResourceCapability {
  return capability.kind === 'resource';
}

export function isPrompt(capability: Capability): capability is PromptCapability {
  return capability.kind === 'prompt';
}
