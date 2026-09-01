import { ConfigError, type Config } from '#profile';
import type { BlobStore } from '#stores/blobs';
import {
  loadProfileSkills,
  readSkill,
  removeSkill,
  writeSkill,
} from '#providers/skills/store.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import { agreed, readStdin, required, withRuntime, type OwnerFlags } from './shared.ts';

/** `lanes link skills` — the reusable procedures agents can invoke. */

/**
 * The store, or a refusal naming why there is none.
 *
 * A profile grants at most one `skills` connection and may grant none
 * (ADR-059), so `store(runtime)` is genuinely absent rather than empty. The two
 * are worth telling apart: "you have no skills" invites writing one, and
 * "this profile is not granted skills" is a config fact the operator has to fix
 * before writing one would do anything.
 */
function store(runtime: { skills: BlobStore | undefined; config: Config }): BlobStore {
  if (runtime.skills) return runtime.skills;
  throw new ConfigError(
    `Profile "${runtime.config.instance.profile}" grants no skills connection.\n` +
      `  Grant one, then try again:\n` +
      `    lanes link grant skills.main --profile ${runtime.config.instance.profile}`,
  );
}


export async function skillsList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const skills = await loadProfileSkills(store(runtime));

    heading(`Skills (${skills.length})`);
    if (skills.length === 0) {
      print(style.dim('  none — add one with: lanes link skills add <name>'));
      return;
    }

    table(
      skills.map((skill) => [
        `  ${skill.name}`,
        skill.arguments.length > 0
          ? style.dim(
              skill.arguments
                .map((argument) => (argument.required ? argument.name : `${argument.name}?`))
                .join(', '),
            )
          : '',
        skill.description,
      ]),
    );

    print('');
    print(style.dim('  Each is the MCP prompt "skills_<name>", where policy allows it.'));
  });
}

export async function skillsShow(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const skillName = required(name, 'lanes link skills show <name>');

  await withRuntime(flags, async (runtime) => {
    const skill = await readSkill(store(runtime), skillName);
    if (!skill) throw new ConfigError(`No skill "${skillName}" in this workspace.`);

    const bytes = await store(runtime).get(skill.path);
    print('');
    print(bytes ? new TextDecoder().decode(bytes) : skill.body);
  });
}

export async function skillsAdd(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const skillName = required(name, 'lanes link skills add <name>   (document on stdin, or --file)');

  const text = flags.file
    ? await Bun.file(flags.file).text()
    : await readStdin(
        `lanes link skills add ${skillName}`,
        'the skill document, frontmatter included',
      );

  await withRuntime(flags, async (runtime) => {
    const existing = await readSkill(store(runtime), skillName);
    const skill = await writeSkill(store(runtime), skillName, text);

    print(ok(`${existing ? 'replaced' : 'added'} skill ${style.bold(skill.name)}`));
    print(
      style.dim(
        `  Available as the prompt "skills_${skill.name}". A running endpoint picks it up within a few seconds.`,
      ),
    );
  });
}

export async function skillsRemove(name: string | undefined, flags: OwnerFlags): Promise<void> {
  const skillName = required(name, 'lanes link skills remove <name>');

  await withRuntime(flags, async (runtime) => {
    const skill = await readSkill(store(runtime), skillName);
    if (!skill) throw new ConfigError(`No skill "${skillName}" in this workspace.`);

    print(`  ${style.bold(skill.name)}  ${skill.description}`);
    print(style.dim(`  ${skill.path}`));
    if (!(await agreed(flags, 'Remove this skill?'))) return;

    await removeSkill(store(runtime), skillName);
    print(ok(`removed skill ${style.bold(skillName)}`));
  });
}
