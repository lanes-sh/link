import { connect } from './commands/connect/index.ts';
import { connectCustom } from './commands/connect/custom/index.ts';
import { disconnect } from './commands/connection.ts';
import { grantConnectionTo, revokeConnectionFrom } from './commands/grant.ts';
import { connectionList } from './commands/connection-list.ts';
import { membersAdd, membersList, membersRemove } from './commands/members.ts';
import { relabel } from './commands/relabel.ts';
import {
  attachFile,
  auditTail,
  auditVerify,
  auth,
  check,
  configShow,
  desktop,
  doctor,
  outputs,
  pair,
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
import { syncTargets } from './commands/sync.ts';
import { targetList, targetShow, targetUse } from './commands/target.ts';
import { identityAdd, identityList, identityRemove } from './commands/identity.ts';
import { setupPlan } from './commands/setup.ts';
import { mcpAdd, mcpList, mcpStdio, skillDocument } from './commands/mcp.ts';
import { deploy } from '#deployments/deploy.ts';
import { secretsList, secretsPush, secretsSet } from './commands/secrets.ts';
import { knowledgeShow, knowledgeUse } from './commands/knowledge.ts';
import { dispatchOwner } from './dispatch-owner.ts';
import { update } from './commands/update.ts';
import {
  all,
  customFlags,
  globalFlags,
  knowledgeFlags,
  ownerFlags,
  parseArgv,
  text,
} from './argv.ts';
import type { GlobalFlags } from './runtime.ts';
import type { OwnerFlags } from './commands/owner/shared.ts';
import { assertKnownFlags } from './selection.ts';
import { requireSelection } from './selection-require.ts';
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

  // Both are read *after* `requireSelection`, which is what resolves
  // `default_workspace` onto `flags` (ADR-061). Capturing them before it would
  // hand every command an undefined workspace on the path the default exists to
  // serve — the flag would be resolved and nothing would be looking.
  let global: GlobalFlags;
  let owner: OwnerFlags;

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

  global = globalFlags(flags);
  owner = ownerFlags(flags, argv);

  switch (first) {
    case 'connect':
      // A nested switch rather than an `if`, so `selection.test.ts` sees
      // `connect custom` when it reads this file for `case` labels: it matches
      // on eight-space indentation, and a command invisible to that check is a
      // command that can default quietly.
      switch (second) {
        case 'custom':
          return connectCustom(rest[0], {
            ...global,
            ...customFlags(flags, argv),
            id: text(flags, 'id'),
            displayName: text(flags, 'display-name'),
            label: text(flags, 'label'),
            replace: flags['replace'] === true,
            nonInteractive: flags['non-interactive'] === true,
            acceptBroadScopes: flags['accept-broad-scopes'] === true,
            json,
          });

        // Not a `case` label, so it adds no row to `SELECTION`: there is no
        // command here to classify, only a usage error.
        case undefined:
          throw new Error(`Usage: ${PROGRAM} connect <provider>`);

        default:
          return connect(second, {
            ...global,
            id: text(flags, 'id'),
            displayName: text(flags, 'display-name'),
            label: text(flags, 'label'),
            replace: flags['replace'] === true,
            nonInteractive: flags['non-interactive'] === true,
            acceptBroadScopes: flags['accept-broad-scopes'] === true,
            ownClient: flags['own-client'] === true,
            auth: text(flags, 'auth'),
            json,
          });
      }

    // The command connecting no longer implies. A connection belongs to the
    // workspace (ADR-057), so which profiles may reach it is a separate say.
    case 'connection':
      if (second !== 'list' && second !== undefined) {
        throw new Error(`Unknown: ${PROGRAM} connection ${second}`);
      }
      return connectionList({ ...global, json });

    case 'grant':
      return grantConnectionTo(second, { ...global, json });

    case 'revoke':
      return revokeConnectionFrom(second, { ...global, json });

    case 'setup':
      if (second !== 'plan' && second !== undefined) {
        throw new Error(`Unknown: ${PROGRAM} setup ${second}`);
      }
      return setupPlan(rest[0], { ...global, json, id: text(flags, 'id') });

    case 'profile':
      switch (second) {
        case 'add':
          if (!rest[0]) {
            throw new Error(`Usage: ${PROGRAM} profile add <name> --workspace <name>`);
          }
          return profileAdd(rest[0], {
            // One target, not a list. A profile declared every target it could
            // run on under contract 1, which is why this read the repeated flag
            // out of argv; it lives in exactly one now (ADR-052), so a second
            // --target would be naming a second place to put the same file.
            targets: [text(flags, 'workspace')!],
            nonInteractive: flags['non-interactive'] === true,
            json,
          });
        case 'list':
        case undefined:
          return profileList(text(flags, 'workspace')!, { json });
        case 'default':
          if (!rest[0]) throw new Error(`Usage: ${PROGRAM} profile default <name>`);
          return profileDefault(rest[0]);
        case 'members': {
          const [action, subject] = rest;
          switch (action) {
            case 'add':
              return membersAdd(subject, {
                ...global,
                json,
                me: flags['me'] === true,
                role: text(flags, 'role'),
              });
            case 'remove':
              return membersRemove(subject, { ...global, json });
            case 'list':
            case undefined:
              return membersList({ ...global, json });
            default:
              throw new Error(`Unknown: ${PROGRAM} profile members ${action}`);
          }
        }
        case 'remove':
          if (!rest[0]) {
            throw new Error(
              `Usage: ${PROGRAM} profile remove <name> [--workspace <name>] [--dry-run] [--yes]`,
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

    // `target` was the old word for the same thing (ADR-061). Kept as its own
    // case rather than aliased, so `selection.test.ts` sees both spellings and
    // neither can default quietly.
    case 'target':
    case 'workspace':
      switch (second) {
        case 'list':
        case undefined:
          return targetList({ ...global, json, urls: flags['urls'] === true });
        case 'use':
          if (!rest[0]) throw new Error(`Usage: ${PROGRAM} workspace use <name>`);
          return targetUse(rest[0]);
        case 'show':
          return targetShow(rest[0], { ...global, json });
        default:
          throw new Error(`Unknown: ${PROGRAM} workspace ${second}`);
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
              `Usage: ${PROGRAM} policy ${second} <capability> --connection <provider>.<id>\n` +
                `  e.g. ${PROGRAM} policy ${second} gmail.send_message --connection gmail.personal,\n` +
                `       or gmail.* for everything that connection's provider offers`,
            );
          }
          return policyRule(second, capability, {
            ...global,
            ...(typeof flags.connection === 'string' ? { connection: flags.connection } : {}),
          });
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

    case 'pair':
      return pair({
        ...global,
        print: flags['print'] === true,
        rotate: flags['rotate'] === true,
        yes: flags['yes'] === true,
      });

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

    // The owner's own data — one subject, dispatched together.
    // `vault key generate` is synchronous, so this returns the result rather
    // than testing it for truthiness.
    case 'memory':
    case 'tasks':
    case 'assets':
    case 'skills':
    case 'vault':
    case 'entities':
      return dispatchOwner(first, second, rest, owner, PROGRAM);

    // Beside `memory` and `skills` because it is the question they raise next:
    // those two say what is stored, and this says where it is kept. Not one of
    // them, though — it takes its own flags rather than the owner set, and it
    // moves those two only (ADR-041), not tasks or assets.
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

    case 'check':
      return check(global);
    case 'plan':
      return plan(global);
    case 'doctor':
      return doctor({ ...global, json, fix: flags['fix'] === true });

    // Beside `doctor` because it answers half of what `doctor` used to guess at,
    // and answers it by asking rather than by dating a credential.
    case 'auth':
      return auth({ ...global, json, connection: text(flags, 'connection') });
    case 'status':
      return status({ ...global, json });
    case 'outputs':
      return outputs({ ...global, show, json });

    // Beside `outputs` for the same reason `tools` is: it answers the next
    // question a person has rather than the next one an agent has. `outputs`
    // hands a harness a URL and a token; this opens the app a person drives all
    // of this from.
    //
    // Two spellings, one behaviour, as `skill` is for `mcp skill`. `dashboard`
    // is what this was called when it opened a page the endpoint served, and
    // that name is in a year of notes; `desktop` is what it does now (ADR-053).
    // Both are in `USAGE`, unlike the `skill` alias, because nobody has learned
    // the new one yet.
    //
    // No `...global`: this resolves nothing, so there is nothing to select.
    case 'dashboard':
    case 'desktop':
      return desktop({ print: flags['print'] === true, yes: flags['yes'] === true });

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
            headless: flags['headless'] === true,
          });
        case 'stdio':
          return mcpStdio({ ...global, ...(flags['only'] === true ? { only: true } : {}) });
        case 'list':
        case undefined:
          return mcpList({
            name: text(flags, 'name'),
            scope: text(flags, 'scope'),
            json: flags['json'] === true,
          });
        default:
          throw new Error(`Unknown: ${PROGRAM} mcp ${second}`);
      }
    case 'disconnect':
      return disconnect(second, {
        ...global,
        yes: flags['yes'] === true,
        keepCredential: flags['keep-credential'] === true,
        json: flags['json'] === true,
      });
    // The new label is joined rather than taken as `rest[0]`, so an unquoted
    // multi-word name works: `relabel gmail.main Work Mail` is what someone
    // types before they think about quoting, and refusing it teaches nothing.
    case 'relabel':
      return relabel(second, rest.length > 0 ? rest.join(' ') : undefined, {
        ...global,
        json: flags['json'] === true,
      });
    case 'start':
      return start({
        ...global,
        port: typeof flags['port'] === 'string' ? Number(flags['port']) : undefined,
        only: flags['only'] === true,
      });

    case 'deploy':
      return deploy({
        ...global,
        // Repeatable, like `profile add --target`: a deploy sends every profile
        // that declares the target, and this narrows that set rather than
        // selecting from it. The first named is the primary (ADR-043).
        profiles: all(argv, 'profile'),
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

    case 'sync':
      switch (second) {
        case undefined:
        case 'targets':
        case 'workspaces':
          return syncTargets({
            ...global,
            dryRun: flags['dry-run'] === true,
            from: text(flags, 'from'),
            discover: flags['discover'] === true,
            prefer: text(flags, 'prefer'),
          });
        default:
          throw new Error(`Unknown: ${PROGRAM} sync ${second}`);
      }

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
