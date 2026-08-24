import { ConfigError } from '#profile';
import {
  loadProfileSkills,
  readSkill,
  removeSkill,
  writeSkill,
} from '#providers/skills/store.ts';
import { heading, ok, print, style, table } from '../../output.ts';
import { agreed, readStdin, required, withRuntime, type OwnerFlags } from './shared.ts';

/** `lanes link skills` — the reusable procedures agents can invoke. */

export async function skillsList(flags: OwnerFlags): Promise<void> {
  await withRuntime(flags, async (runtime) => {
    const skills = await loadProfileSkills(runtime.skills);

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
    const skill = await readSkill(runtime.skills, skillName);
    if (!skill) throw new ConfigError(`No skill "${skillName}" in this workspace.`);

    const bytes = await runtime.skills.get(skill.path);
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
    const existing = await readSkill(runtime.skills, skillName);
    const skill = await writeSkill(runtime.skills, skillName, text);

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
    const skill = await readSkill(runtime.skills, skillName);
    if (!skill) throw new ConfigError(`No skill "${skillName}" in this workspace.`);

    print(`  ${style.bold(skill.name)}  ${skill.description}`);
    print(style.dim(`  ${skill.path}`));
    if (!(await agreed(flags, 'Remove this skill?'))) return;

    await removeSkill(runtime.skills, skillName);
    print(ok(`removed skill ${style.bold(skillName)}`));
  });
}
