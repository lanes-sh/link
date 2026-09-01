import { KNOWLEDGE_LAYOUT, layout, soleGrantFor } from '#profile';
import { announce, emit, heading, print, style, table } from '../../output.ts';
import { openRuntime } from '../../runtime.ts';
import type { KnowledgeFlags } from './index.ts';

/**
 * `lanes link knowledge show` — where memory, skills and entities actually are.
 *
 * Split from `knowledge use` so `index.ts` stays inside the size budget, on the
 * seam the two commands already have: this one opens stores and counts, and
 * never writes. That difference is why `show` can answer for a repository `use`
 * would refuse to touch.
 */

export async function knowledgeShow(flags: KnowledgeFlags): Promise<void> {
  const runtime = await openRuntime(flags, { fetch: flags.fetch });
  try {
    if (!flags.json) announce(runtime.resolution);

    const profile = runtime.config.instance.profile;
    const selection = ` --profile ${runtime.resolution.profile} --target ${runtime.target}`;
    const skills = runtime.skills ? (await runtime.skills.list()).length : 0;
    const memory = (await runtime.storage.list(`${KNOWLEDGE_LAYOUT.memory}/`)).length;
    const entities = (await runtime.storage.list(`${KNOWLEDGE_LAYOUT.entities}/`)).length;
    const where = runtime.knowledge?.describe;
    // Null when no skills connection is granted (ADR-059). The row still prints,
    // saying so: a missing row reads as "there are none", not "not granted".
    const skillsConnection = soleGrantFor(runtime.config, 'skills');

    if (flags.json) {
      print(
        JSON.stringify(
          { target: runtime.target, where: where ?? 'local', memory, skills, entities },
          null,
          2,
        ),
      );
      return;
    }

    heading('Knowledge');
    table([
      // The memory *directory*, not the blob root it sits in. `layout.blobs`
      // is `data/`, which is where every provider's namespace lives —
      // printing it here would name a directory that is mostly not memory.
      [
        '  memory',
        where ? `${where}/${KNOWLEDGE_LAYOUT.memory}` : `${layout.blobs()}/${KNOWLEDGE_LAYOUT.memory}`,
        style.dim(`${memory} file${memory === 1 ? '' : 's'}`),
      ],
      [
        '  skills',
        where
          ? `${where}/${KNOWLEDGE_LAYOUT.skills}`
          : skillsConnection
            ? layout.skills(skillsConnection)
            : style.dim('not granted'),
        style.dim(`${skills} file${skills === 1 ? '' : 's'}`),
      ],
      // The count includes the derived `_index.json`, deliberately: it is a
      // file in that directory and it is committed with the rest, so a number
      // that quietly excluded it would not match what a person sees there.
      [
        '  entities',
        where
          ? `${where}/${KNOWLEDGE_LAYOUT.entities}`
          : `${layout.blobs()}/${KNOWLEDGE_LAYOUT.entities}`,
        style.dim(`${entities} file${entities === 1 ? '' : 's'}`),
      ],
    ]);

    print('');
    print(
      style.dim(
        `  The vault, the credential store, runtime state and the audit log stay in workspace "${runtime.target}".`,
      ),
    );
    // Complete commands, not shapes. Every one of these is pasted, and with
    // nothing left to fall back on (ADR-037) a line missing either flag is a
    // line that refuses — `emitted.test.ts` states the rule for the templates
    // reachable without a runtime, and this is the same rule where there is one.
    print(
      style.dim(
        where
          ? `  Bring them back with: lanes link knowledge use local --migrate${selection}`
          : `  Keep them in a repository with: lanes link knowledge use github --repo <owner/name>${selection}`,
      ),
    );
  } finally {
    await runtime.close();
  }
}
