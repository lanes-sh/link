import { connect } from './commands/connect/index.ts';
import {
  attachFile,
  auditTail,
  auditVerify,
  check,
  configShow,
  dashboard,
  doctor,
  outputs,
  plan,
  policyList,
  policyRule,
  start,
  status,
  tokenRotate,
  tokenShow,
  tools,
} from './commands/operate.ts';
import { profileAdd, profileDefault, profileList } from './commands/profile.ts';
import { removeProfile as profileRemove } from './commands/profile/remove.ts';
import { targetList, targetShow, targetUse } from './commands/target.ts';
import { identityAdd, identityList, identityRemove } from './commands/identity.ts';
import { setupPlan } from './commands/setup.ts';
import { mcpAdd, mcpList, mcpStdio, skillDocument } from './commands/mcp.ts';
import { deploy } from '#deployments/deploy.ts';
import { secretsList, secretsPush, secretsSet } from './commands/secrets.ts';
import {
  memoryForget,
  memoryGet,
  memoryList,
  memoryWrite,
  skillsAdd,
  skillsList,
  skillsRemove,
  skillsShow,
  vaultGet,
  vaultKeyGenerate,
  vaultList,
  vaultRemove,
  vaultSet,
} from './commands/owner.ts';
import { knowledgeShow, knowledgeUse } from './commands/knowledge.ts';
import { update } from './commands/update.ts';
import { all, globalFlags, knowledgeFlags, ownerFlags, parseArgv, text } from './argv.ts';
import { assertKnownFlags, requireSelection } from './selection.ts';
import { PROGRAM, USAGE } from './usage.ts';
import { version } from './version.ts';
import { print } from './output.ts';

/**
 * `lanes link` — the control plane.
 *
 * Every control-plane operation lives here and nowhere else. Policy changes,
 * token management, credential writing, and config mutation each authorise
 * *future* agent behaviour, so the decision has to originate outside the
 * agent — ADR-007. There is no admin API, and a running instance never
 * mutates its own configuration.
 *
 * What is left in this file is the grammar and nothing else: which word maps to
 * which function. Parsing argv is `argv.ts`, the help text is `usage.ts`, and
 * every command is under `commands/`.
 */

export async function run(argv: readonly string[]): Promise<void> {
  const { command, flags } = parseArgv(argv);
  const [first, second, ...rest] = command;

  const global = globalFlags(flags);
  const owner = ownerFlags(flags);

  const show = flags['show'] === true;
  const raw = flags['raw'] === true;
  const json = flags['json'] === true;

  if (!first || first === 'help' || flags['help'] === true) {
    print(USAGE);
    return;
  }

  // Before the switch, so no command can be reached having been handed a flag it
  // does not read or missing one it needs. One call site rather than a check per
  // case: the reported bug was a single command building its own options literal
  // and dropping `--target` into it, which is exactly what a per-case check
  // leaves room for.
  assertKnownFlags(first, second, flags);
  await requireSelection(first, second, flags);

  switch (first) {
    case 'connect':
      if (!second) throw new Error(`Usage: ${PROGRAM} connect <provider>`);
      return connect(second, {
        ...global,
        id: text(flags, 'id'),
        displayName: text(flags, 'display-name'),
        replace: flags['replace'] === true,
        nonInteractive: flags['non-interactive'] === true,
        acceptBroadScopes: flags['accept-broad-scopes'] === true,
        ownClient: flags['own-client'] === true,
        auth: text(flags, 'auth'),
        json,
      });

    case 'setup':
      if (second !== 'plan' && second !== undefined) {
        throw new Error(`Unknown: ${PROGRAM} setup ${second}`);
      }
      return setupPlan(rest[0], { ...global, json, id: text(flags, 'id') });

    case 'profile':
      switch (second) {
        case 'add':
          if (!rest[0]) {
            throw new Error(`Usage: ${PROGRAM} profile add <name> --target <name> [--target <name>]`);
          }
          return profileAdd(rest[0], {
            // Read from argv rather than from `flags`, because this is the one
            // place a flag is a list: a profile declares every target it can run
            // on, and the parser keeps only the last value of a repeated flag.
            targets: all(argv, 'target'),
            nonInteractive: flags['non-interactive'] === true,
            json,
          });
        case 'list':
        case undefined:
          return profileList({ json });
        case 'default':
          if (!rest[0]) throw new Error(`Usage: ${PROGRAM} profile default <name>`);
          return profileDefault(rest[0]);
        case 'remove':
          if (!rest[0]) {
            throw new Error(
              `Usage: ${PROGRAM} profile remove <name> [--target t] [--dry-run] [--yes]`,
            );
          }
          return profileRemove(rest[0], {
            ...global,
            json,
            dryRun: flags['dry-run'] === true,
            yes: flags['yes'] === true,
          });
        default:
          throw new Error(`Unknown: ${PROGRAM} profile ${second}`);
      }

    case 'target':
      switch (second) {
        case 'list':
        case undefined:
          return targetList({ ...global, json, urls: flags['urls'] === true });
        case 'use':
          if (!rest[0]) throw new Error(`Usage: ${PROGRAM} target use <name>`);
          return targetUse(rest[0]);
        case 'show':
          return targetShow(rest[0], { ...global, json });
        default:
          throw new Error(`Unknown: ${PROGRAM} target ${second}`);
      }

    case 'identity': {
      // Both subcommands take the same two positionals, so the usage line is
      // built once rather than written twice with one of them going stale.
      const [kind, value] = rest;
      const usage = (form: string): string =>
        `Usage: ${PROGRAM} identity ${form}\n  e.g. ${PROGRAM} identity add name "Your Name" --note "for open-source work"`;

      switch (second) {
        case 'add':
          if (!kind || !value) throw new Error(usage('add <kind> <value> [--note text]'));
          return identityAdd(kind, value, { ...global, note: text(flags, 'note'), json });
        case 'list':
        case undefined:
          return identityList({ ...global, json });
        case 'remove':
          if (!kind || !value) throw new Error(usage('remove <kind> <value>'));
          return identityRemove(kind, value, { ...global, json });
        default:
          throw new Error(`Unknown: ${PROGRAM} identity ${second}`);
      }
    }

    case 'policy':
      switch (second) {
        case 'list':
        case undefined:
          return policyList(global);
        case 'allow':
        case 'deny': {
          const [capability] = rest;
          if (!capability) {
            throw new Error(
              `Usage: ${PROGRAM} policy ${second} <capability>\n` +
                `  e.g. ${PROGRAM} policy ${second} gmail.send_message, or gmail.* for the whole provider`,
            );
          }
          return policyRule(second, capability, global);
        }
        default:
          throw new Error(`Unknown: ${PROGRAM} policy ${second}`);
      }

    case 'token':
      switch (second) {
        case 'show':
        case undefined:
          return tokenShow({ ...global, show, raw });
        case 'rotate':
          return tokenRotate({ ...global, show });
        default:
          throw new Error(`Unknown: ${PROGRAM} token ${second}`);
      }

    case 'audit':
      if (second === 'verify') return auditVerify(global);
      if (second !== 'tail' && second !== undefined) {
        throw new Error(`Unknown: ${PROGRAM} audit ${second}`);
      }
      return auditTail({
        ...global,
        limit: typeof flags['limit'] === 'string' ? Number(flags['limit']) : undefined,
        deniedOnly: flags['denied-only'] === true,
        ...(typeof flags['format'] === 'string' ? { format: flags['format'] } : {}),
      });

    // The file is positional rather than `--file`, because `attach <file>` is
    // how every other tool spells it and this one is typed by a person.
    case 'attach':
      return attachFile({
        ...global,
        file: second,
        connection: text(flags, 'connection'),
      });

    case 'config':
      if (second !== 'show' && second !== undefined) throw new Error(`Unknown: ${PROGRAM} config ${second}`);
      return configShow(global);

    case 'memory':
      switch (second) {
        case 'list':
        case undefined:
          return memoryList(owner);
        case 'get':
          return memoryGet(rest[0], owner);
        case 'write':
          return memoryWrite(rest[0], owner);
        case 'forget':
          return memoryForget(rest[0], owner);
        default:
          throw new Error(`Unknown: ${PROGRAM} memory ${second}`);
      }

    case 'skills':
      switch (second) {
        case 'list':
        case undefined:
          return skillsList(owner);
        case 'show':
          return skillsShow(rest[0], owner);
        case 'add':
          return skillsAdd(rest[0], owner);
        case 'remove':
          return skillsRemove(rest[0], owner);
        default:
          throw new Error(`Unknown: ${PROGRAM} skills ${second}`);
      }

    // Beside `memory` and `skills` because it is the question they raise next:
    // those two say what is stored, and this says where it is kept.
    case 'knowledge':
      switch (second) {
        case 'show':
        case undefined:
          return knowledgeShow(knowledgeFlags(flags));
        case 'use':
          return knowledgeUse(rest[0], knowledgeFlags(flags));
        default:
          throw new Error(`Unknown: ${PROGRAM} knowledge ${second}`);
      }

    case 'vault':
      switch (second) {
        case 'list':
        case undefined:
          return vaultList(owner);
        case 'get':
          return vaultGet(rest[0], owner);
        case 'set':
          return vaultSet(rest[0], owner);
        case 'remove':
          return vaultRemove(rest[0], owner);
        case 'key':
          if (rest[0] !== 'generate') {
            throw new Error(`Usage: ${PROGRAM} vault key generate`);
          }
          return vaultKeyGenerate(owner);
        default:
          throw new Error(`Unknown: ${PROGRAM} vault ${second}`);
      }

    case 'check':
      return check(global);
    case 'plan':
      return plan(global);
    case 'doctor':
      return doctor({ ...global, json });
    case 'status':
      return status({ ...global, json });
    case 'outputs':
      return outputs({ ...global, show, json });

    // Beside `outputs` for the same reason `tools` is: it answers the next
    // question a person has rather than the next one an agent has. `outputs`
    // hands a harness a URL and a token; this opens the one page a person can
    // read, and only a local endpoint serves it.
    case 'dashboard':
      return dashboard({ ...global, print: flags['print'] === true });

    // Beside `outputs` because it answers the next question. `outputs` says
    // where the endpoint is; this says what it would hand a client that asked
    // right now — which is the only way to tell a stale client from a wrong
    // endpoint without reading request sizes out of a log.
    case 'tools':
      return tools({ ...global, json });

    // Undocumented alias for `mcp skill`, which is where it moved when `skills`
    // arrived. Anyone who learned the old spelling keeps it.
    case 'skill':
      return skillDocument({ print: flags['print'] === true });

    case 'mcp':
      switch (second) {
        // `lanes link skill` was this, before `lanes link skills` existed. Two
        // commands one letter apart, meaning entirely different things — the
        // agent-side skill file that teaches a harness to register this
        // endpoint, and the owner's own procedures — is a trap worth closing.
        // Kept working below rather than removed, undocumented.
        case 'skill':
          return skillDocument({ print: flags['print'] === true });
        case 'add':
          return mcpAdd(rest[0], {
            ...global,
            name: text(flags, 'name'),
            scope: text(flags, 'scope'),
            tokenEnv: text(flags, 'token-env'),
            dryRun: flags['dry-run'] === true,
            force: flags['force'] === true,
            noSkill: flags['no-skill'] === true,
          });
        case 'stdio':
          return mcpStdio({ ...global, ...(flags['only'] === true ? { only: true } : {}) });
        case 'list':
        case undefined:
          return mcpList({ name: text(flags, 'name'), scope: text(flags, 'scope') });
        default:
          throw new Error(`Unknown: ${PROGRAM} mcp ${second}`);
      }
    case 'start':
      return start({
        ...global,
        port: typeof flags['port'] === 'string' ? Number(flags['port']) : undefined,
        only: flags['only'] === true,
      });

    case 'deploy':
      return deploy({
        ...global,
        dryRun: flags['dry-run'] === true,
        // `--iam` was a boolean that meant "add the platform's own check on top".
        // It is now one of two values of a declared field, because the opposite
        // is a choice too and a flag that only turns something on cannot express
        // turning it off again for a target whose config says otherwise.
        access: flags['iam'] === true ? 'iam' : text(flags, 'access'),
        serviceAccount: text(flags, 'service-account'),
        tag: text(flags, 'tag'),
        yes: flags['yes'] === true,
        nonInteractive: flags['non-interactive'] === true,
      });

    case 'secrets':
      switch (second) {
        case 'push':
          return secretsPush({
            ...global,
            from: text(flags, 'from'),
            to: text(flags, 'to'),
            overwrite: flags['overwrite'] === true,
            dryRun: flags['dry-run'] === true,
          });
        case 'set':
          return secretsSet(rest[0], global);
        case 'list':
        case undefined:
          return secretsList(global);
        default:
          throw new Error(`Unknown: ${PROGRAM} secrets ${second}`);
      }

    case 'version':
      print(version());
      return;

    case 'update':
      return update({ check: flags['check'] === true, json });

    default:
      throw new Error(`Unknown command "${first}". Run: ${PROGRAM} help`);
  }
}
