import { progress, style } from '../../../output.ts';
import type { Prompter } from '../../../prompt.ts';
import { parseAuthMethod, parseConnectorKind, refuseIllegalPair } from './derive.ts';
import {
  AUTH_FIELDS,
  AUTH_METHODS,
  CONNECTOR_FIELDS,
  CONNECTOR_KINDS,
  camel,
  titleCase,
  type CustomAnswers,
  type CustomFlags,
  type FieldSpec,
} from './spec.ts';

/**
 * Collecting what the flags did not say.
 *
 * Every value has a flag, so the whole command is scriptable — but the fields
 * differ per connectivity type and per credential type, and nobody holds thirty
 * flag names in their head to declare one provider. So a missing required value
 * is asked for, in a fixed order, and the answers are indistinguishable from
 * having been typed.
 *
 * Under `--non-interactive` nothing is asked and *everything* missing is named
 * at once, with the command to re-run. One round trip rather than one refusal
 * per flag, because the caller there is usually a script or an agent and each
 * refusal costs it a whole run.
 */

/** Named, not asked: nothing can be collected until the two lists are picked. */
export interface Blocked {
  readonly missing: readonly string[];
  readonly command: string;
}

export async function collect(
  id: string,
  flags: CustomFlags,
  prompter: Prompter,
  /** How to spell the re-run, when there is nothing to ask. */
  commandFor: (missing: readonly string[]) => string,
): Promise<CustomAnswers | Blocked> {
  const missing: string[] = [];

  const connector = flags.connector
    ? parseConnectorKind(flags.connector)
    : prompter.interactive
      ? parseConnectorKind(await choose(prompter, 'How is this service reached?', CONNECTOR_KINDS))
      : (missing.push('connector'), undefined);

  const auth = flags.auth
    ? parseAuthMethod(flags.auth)
    : prompter.interactive
      ? parseAuthMethod(await choose(prompter, 'How does it authenticate?', AUTH_METHODS))
      : (missing.push('auth'), undefined);

  // Which fields exist at all depends on the two answers above, so a
  // non-interactive run missing either cannot list the rest yet. Saying so beats
  // guessing at a list that would be wrong.
  if (!connector || !auth) return { missing, command: commandFor(missing) };

  // Before a single field is asked for. The pair is decided by the two answers
  // above, so a combination that cannot work is knowable here — and asking six
  // questions about a mailbox that will be refused for its credential type is
  // worse than refusing straight away.
  refuseIllegalPair(connector, auth);

  const fields = [...CONNECTOR_FIELDS[connector], ...AUTH_FIELDS[auth], ...EXTRA];
  const values: Record<string, string | readonly string[]> = {};

  for (const field of fields) {
    const given = flags[camel(field.flag) as keyof CustomFlags];

    if (Array.isArray(given)) {
      if (given.length > 0) values[field.flag] = given;
      continue;
    }
    if (typeof given === 'string' && given.length > 0) {
      values[field.flag] = given;
      continue;
    }
    if (!field.required) continue;

    if (!prompter.interactive) {
      missing.push(field.flag);
      continue;
    }

    const answer = field.choices
      ? await choose(prompter, field.label, field.choices)
      : await askFor(prompter, field);

    if (answer.length > 0) values[field.flag] = answer;
    else missing.push(field.flag);
  }

  if (missing.length > 0) return { missing, command: commandFor(missing) };

  const name = flags.name ?? (prompter.interactive ? await askName(prompter, id) : titleCase(id));

  return {
    id,
    name,
    ...(flags.description ? { description: flags.description } : {}),
    connector,
    auth,
    values,
  };
}

/**
 * Fields that belong to no single kind.
 *
 * All optional, so a non-interactive run is never blocked on one — and none is
 * prompted for, because a question nobody needs to answer is worse than a flag
 * nobody types. `derive.ts` refuses the combinations that do not work.
 */
const EXTRA: readonly FieldSpec[] = [
  { flag: 'identity-url', label: 'Identity URL', required: false },
  { flag: 'identity-field', label: 'Identity field', required: false },
  { flag: 'setup-docs', label: 'Where to get the credential', required: false },
];

async function askFor(prompter: Prompter, field: FieldSpec): Promise<string> {
  if (field.hint) progress(style.dim(`  ${field.hint}`));
  return (await prompter.ask(field.label)).trim();
}

async function askName(prompter: Prompter, id: string): Promise<string> {
  const suggested = titleCase(id);
  const answer = (await prompter.ask(`Display name [${suggested}]`)).trim();
  return answer.length > 0 ? answer : suggested;
}

/**
 * A closed set, offered as a numbered list.
 *
 * The same shape `chooseAuthMethod` uses for a provider with more than one way
 * in, for the same reason: these are the members of a union, and typing one from
 * memory is how somebody discovers a name is `api-key` and not `apikey` by
 * being refused.
 */
async function choose(
  prompter: Prompter,
  question: string,
  options: readonly string[],
): Promise<string> {
  progress();
  progress(question);
  options.forEach((option, index) => progress(`  ${index + 1}. ${option}`));

  const answer = (await prompter.ask(`Choose 1-${options.length}`)).trim();
  const index = Number(answer);

  // A name is accepted too. Somebody who already knows it should not have to
  // count, and the numbers exist for somebody who does not.
  if (options.includes(answer)) return answer;
  if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1]!;

  throw new Error(`"${answer}" is not one of: ${options.join(', ')}.`);
}
