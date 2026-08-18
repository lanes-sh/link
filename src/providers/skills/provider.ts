import { z } from 'zod';
import {
  loadWorkspaceSkills,
  readSkill,
  removeSkill,
  renderSkill,
  writeSkill,
  type LoadedSkill,
} from './store.ts';
import {
  defineLocalProvider,
  keepKeys,
  type BlobStore,
  type Capability,
  type ProviderDefinition,
} from '#connectivity';

/**
 * `skills` — reusable procedures, on the MCP prompts primitive.
 *
 * **Skills are invoked, not read** (ADR-012 §1). The discriminator is whether
 * the answer depends on arguments: a resource is a function of its URI alone,
 * and "review this diff" is a function of the diff. Against a tool: a tool
 * result returns to the model as data it reasons about, while a prompt returns
 * as messages that *become* the conversation — and a procedure wants the
 * second. This is the case ADR-006 reserved the primitive for. That part is
 * unchanged.
 *
 * **What changed is that a skill can now be written (ADR-014).** ADR-012 §1
 * refused the write path outright: a skill is instructions, so an agent able to
 * author one could persist its own future behaviour. The argument was right and
 * the conclusion was too strong. It is the same risk `memory.write` carries —
 * text an agent authors, stored once, re-served to every later session — and
 * memory answered it by making writing a separate capability in a non-default
 * bundle rather than by having no write path at all. Skills now answer it the
 * same way, and the asymmetry between the two goes away.
 *
 * Two things preserve the narrower half of ADR-012 §1:
 *
 *   - **Authoring is not in the default bundle.** `lanes link connect skills` grants
 *     `skills.*`, so narrowing it is a `deny: [skills.manage.*]` line — the
 *     same one-line narrowing memory documents, and stated as plainly.
 *   - **`skills.manage.get` is in the write bundle, not the read one.** A
 *     read-only agent still cannot read a skill body and so cannot select its
 *     own instructions from one; the prompt primitive's user-selected framing
 *     survives for every agent that has not been granted authoring.
 *
 * The management tools live under `manage.` rather than at the top level
 * because a skill named `write` would otherwise be the capability
 * `skills.write` twice over. Skill names cannot contain a dot, so
 * `skills.manage.*` can only ever mean these four.
 */

export interface SkillsProviderOptions {
  /**
   * The skills currently in the store. Read by the caller because loading them
   * is asynchronous and building a provider is not, and because the runtime is
   * the right place to decide when the store is touched.
   */
  readonly skills: readonly LoadedSkill[];
  /**
   * Where skills live. Omitted for a read-only provider — one built without a
   * store has no authoring capabilities at all, rather than four that fail.
   */
  readonly store?: BlobStore;
  /**
   * Called after a write or a removal, so the registry can pick the change up.
   *
   * Each skill is its own capability, so a newly written one is invisible until
   * the provider is rebuilt. The provider cannot rebuild itself and should not
   * know how; it says that something changed, and the runtime decides what that
   * means.
   */
  readonly onChange?: () => Promise<void>;
}

export function createSkillsProvider(options: SkillsProviderOptions): ProviderDefinition {
  const seen = new Set<string>();
  const capabilities: Capability[] = [];

  for (const skill of options.skills) {
    if (seen.has(skill.name)) {
      throw new Error(
        `Two skills are both named "${skill.name}" (${skill.path}). A skill name becomes the capability id "skills.${skill.name}", which must be unique.`,
      );
    }
    seen.add(skill.name);

    capabilities.push({
      kind: 'prompt',
      name: skill.name,
      ...(skill.title ? { title: skill.title } : {}),
      description: skill.description,
      arguments: skill.arguments.map((argument) => ({
        name: argument.name,
        description: argument.description,
        ...(argument.required ? { required: true } : {}),
      })),
      // The arguments are the procedure's parameters and are recorded by name
      // and type only — the default. A skill argument routinely carries the very
      // material the skill is about.
      async render(args) {
        return {
          messages: [{ role: 'user', text: renderSkill(skill.body, args) }],
        };
      },
    });
  }

  const manage = options.store ? managementCapabilities(options.store, options.onChange) : [];

  return defineLocalProvider({
    id: 'skills',
    name: 'Skills',
    version: '1.0.0',
    description:
      "Reusable procedures the owner has written, offered as MCP prompts. Authoring them is a separate capability from invoking them, and is not granted by default.",

    configSchema: z.object({}),
    connectionSchema: z.object({}),

    bundles: [
      {
        name: 'read',
        description: 'Invoke the owner-authored skills.',
        oauth_scopes: [],
        // Every skill, and nothing that reads or writes a skill's source.
        // Per-skill control is a policy line — `deny: [skills.review_diff]` —
        // rather than a bundle.
        capabilities: [...seen],
        default: true,
      },
      ...(manage.length > 0
        ? [
            {
              // Not in the default bundle, for the reason in the docstring: a
              // skill an agent writes is instructions it will be handed later.
              name: 'author',
              description: 'Read, create, and delete the skills themselves.',
              oauth_scopes: [],
              capabilities: manage.map((capability) => capability.name),
            },
          ]
        : []),
    ],

    capabilities: [...capabilities, ...manage],
  });
}

function managementCapabilities(
  store: BlobStore,
  onChange: (() => Promise<void>) | undefined,
): Capability[] {
  const changed = async (): Promise<void> => {
    await onChange?.();
  };

  return [
    {
      kind: 'tool',
      name: 'manage.list',
      title: 'List skills',
      description:
        'Every skill that exists, with its description and arguments. The prompt list shows only the ones policy permits; this shows what is stored.',
      inputSchema: z.object({}),
      async handler(_input, context) {
        const skills = await loadWorkspaceSkills(store);

        if (skills.length === 0) {
          return { content: [{ type: 'text', text: `No skills on ${context.connection.key}.` }] };
        }

        return {
          content: [
            {
              type: 'text',
              text: skills
                .map((skill) => {
                  const args = skill.arguments
                    .map((argument) => (argument.required ? argument.name : `${argument.name}?`))
                    .join(', ');
                  return `${skill.name}${args ? `(${args})` : ''} — ${skill.description}`;
                })
                .join('\n'),
            },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'manage.get',
      title: 'Read a skill',
      description:
        'Return a skill exactly as stored, frontmatter included — what to edit before writing it back.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Skill name'),
      }),
      redact: keepKeys('name'),
      async handler({ name }, context) {
        const skill = await readSkill(store, name);

        if (skill === null) {
          return {
            content: [{ type: 'text', text: `No skill "${name}" on ${context.connection.key}.` }],
            isError: true,
          };
        }

        // The stored document, not the parsed body: an edit-then-write round
        // trip has to carry the frontmatter with it.
        const bytes = await store.get(skill.path);
        return {
          content: [
            { type: 'text', text: bytes ? new TextDecoder().decode(bytes) : skill.body },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'manage.write',
      title: 'Write a skill',
      description:
        'Create or replace a skill. The text is a whole Markdown document: YAML frontmatter carrying "description" and optional "arguments", then the procedure body, where {{argument}} is substituted at invocation. A skill written here is instructions an agent is later handed as its own turn — this is deliberately a separate capability from invoking one.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe('Skill name: lowercase letters, digits, "_" or "-". Becomes skills.<name>.'),
        text: z.string().min(1).describe('The whole document, frontmatter included'),
      }),
      // The name is an address and is worth recording; the text is the
      // instructions themselves, which are the content rather than the subject.
      redact: keepKeys('name'),
      async handler({ name, text }, context) {
        const skill = await writeSkill(store, name, text);
        await changed();

        context.audit.annotate({ skill: name, bytes: new TextEncoder().encode(text).byteLength });

        return {
          content: [
            {
              type: 'text',
              text: `Stored skill "${skill.name}" on ${context.connection.key}. It is available as the prompt "skills_${skill.name}" where policy allows it.`,
            },
          ],
        };
      },
    },

    {
      kind: 'tool',
      name: 'manage.remove',
      title: 'Delete a skill',
      description: 'Remove a skill and the prompt it provided.',
      inputSchema: z.object({
        name: z.string().min(1).describe('Skill name'),
      }),
      redact: keepKeys('name'),
      async handler({ name }, context) {
        const removed = await removeSkill(store, name);
        if (removed) await changed();

        return {
          content: [
            {
              type: 'text',
              text: removed
                ? `Removed skill "${name}" from ${context.connection.key}.`
                : `No skill "${name}" on ${context.connection.key}.`,
            },
          ],
          ...(removed ? {} : { isError: true }),
        };
      },
    },
  ];
}
