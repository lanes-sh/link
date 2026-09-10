import { layout } from '#profile';
import { print, style, warn } from '../../output.ts';
import type { RemovalItem, RemovalPlan, SubjectReport } from './removal.ts';

/**
 * The plan, as the thing an operator decides from.
 *
 * Split from `removal.ts` when the degraded banner arrived and took that file
 * past the budget — the same seam `confirm.ts` records finding, and the same
 * kind of seam: one file was planning a removal and describing one. What must
 * not change is that this renders *the value that is executed*, so there is no
 * second description of the work to fall out of step with the first.
 *
 * It prints references and keys and never a value. The plan holds no values to
 * print, and `removalSubject` runs `findSecrets` over anything it salvaged
 * before it can reach here.
 */

const KIND_LABEL: Record<RemovalItem['kind'], string> = {
  secret: 'credential',
  blob: 'object',
  file: 'file',
  config: 'config',
  'workspace-key': 'workspace',
};

export function renderPlan(plan: RemovalPlan): void {
  print();
  print(`Removing profile ${style.bold(plan.profile)} would delete:`);
  print();

  renderDegraded(plan.subject);

  if (plan.items.length === 0) {
    print(style.dim('  nothing — there is no trace of this profile left to remove.'));
  }

  const targets = [...new Set(plan.items.map((item) => item.target))];
  for (const target of targets) {
    const items = plan.items.filter((item) => item.target === target);
    print(`  ${style.bold(target ?? 'workspace')}`);
    for (const item of items) {
      const note = item.note ? style.dim(` — ${item.note}`) : '';
      const shown = item.area === undefined ? item.id : `${item.area}/${item.id}`;
      const into = item.movedTo ? style.dim(` → ${item.movedTo[0]}/${item.movedTo[1]}`) : '';
      print(`    ${KIND_LABEL[item.kind].padEnd(10)} ${shown}${into}${note}`);
    }
    print();
  }

  for (const { target, refs } of plan.untouched) {
    // Named rather than counted, because the operator is the only one who can
    // tell an orphan from another profile's live credential — and this command
    // deliberately will not guess.
    print(`  ${style.bold(target)}: present but not declared by this profile, so left alone`);
    for (const ref of refs) print(style.dim(`    ${ref}`));
    print();
  }

  for (const warning of plan.warnings) print(warn(warning));
  if (plan.warnings.length > 0) print();

  if (plan.unreachable.length > 0) {
    print(`  ${style.bold('Not reachable from a config that will not load, so not removed')}`);
    for (const line of plan.unreachable) print(style.dim(`    ${line}`));
    print();
  }
}

/**
 * What was read of a config that would not load, before the items it produced.
 *
 * The question this has to answer is "which of the items below are guesses",
 * and the answer is none of them: every one comes from listing a store, from
 * the target's own declaration, or from the name the operator typed. A field
 * this could not read removes a line from the plan and can never add a wrong
 * one — so the paragraph says that outright rather than leaving an operator to
 * decide how much of the preview to believe.
 */
function renderDegraded(subject: SubjectReport): void {
  if (subject.loaded) return;

  const nothing = subject.unread.length === FIELD_LABELS.size;
  print(
    warn(
      `${layout.profileConfig(subject.name)} will not load, so this is working from ` +
        (nothing ? 'the file\'s name alone — nothing could be read from it, not even as YAML:'
                 : 'what could be read of it:'),
    ),
  );

  for (const [field, label] of FIELD_LABELS) {
    print(`        ${label.padEnd(18)}${style.dim(described(subject, field))}`);
  }

  print(style.dim('      Everything below was found by listing the stores, not by reading that'));
  print(style.dim('      file. What a config that will not load costs is a line that is missing'));
  print(style.dim('      here, never one that is wrong.'));
  if (subject.refusal !== null) print(style.dim(`      What refused it: ${subject.refusal}`));
  print();
}

const FIELD_LABELS = new Map([
  ['name', 'instance.profile'],
  ['grants', 'vault connection'],
  ['auth', 'authorization'],
  ['knowledge', 'knowledge'],
]);

/** One field's line: what was read, or that it could not be. */
function described(subject: SubjectReport, field: string): string {
  if (subject.unread.includes(field)) return 'could not be read';

  switch (field) {
    case 'name':
      return subject.assumedName
        ? `${subject.name} (the directory's — the file names another)`
        : subject.name;
    case 'grants':
      return subject.vaultConnection ?? 'none granted';
    case 'auth':
      return subject.clientIdRef ?? 'no client id declared';
    default:
      return subject.knowledgeRepo ?? 'not declared';
  }
}
