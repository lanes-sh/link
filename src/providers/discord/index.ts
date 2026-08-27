import { defineProvider } from '#connectivity';
import { DISCORD_HINTS } from './hints.ts';
import { DISCORD_REDACT } from './redact.ts';

/**
 * Discord asks callers to identify themselves and blocks the ones that do not.
 *
 * Their documented format is `DiscordBot ($url, $version)`, and a request with a
 * generic or absent agent is refused at the edge rather than by the API — so it
 * presents as a network failure with no JSON to read. `connector.headers` on an
 * `http` connector is what carries it (ADR-045 added the field for the same
 * problem at Reddit).
 *
 * No handle or address in it: this file is public, and `architecture.test.ts`
 * refuses a real identifier anywhere a reader can see. A name and a URL are what
 * the check actually looks for.
 */
const DISCORD_USER_AGENT = 'DiscordBot (https://lanes.sh/link, 0.3)';

/** The vendored spec sits beside this file. See `specs/vendor.ts`. */
function specPath(name: string): string {
  return new URL(`./specs/${name}`, import.meta.url).pathname;
}

/**
 * Discord's v10 HTTP API, reached with a bot token the operator pasted.
 *
 * There is no user-account path and it is not for want of looking. Discord
 * publishes no API for acting as yourself: automating a user token is
 * self-botting, which their terms forbid and which gets accounts terminated, and
 * the OAuth2 user scopes cover neither posting to a channel nor reading its
 * history. Everything an integration can legitimately do, it does as an
 * application. So a message will always carry an APP badge — that part is not
 * negotiable — but the *name and avatar* on it are, per message, through a
 * webhook. `execute_webhook` is why the three webhook operations are vendored:
 * an announcement can read as the operator while an ordinary reply reads as the
 * integration, from the one token.
 *
 * Not OAuth, and for a reason of its own rather than the one ADR-033 gave. That
 * reason — a vendor matching its callback URL exactly, against a port the kernel
 * picks — was withdrawn by ADR-045, which added `auth.redirect_uri`; so it is no
 * longer an argument for a pasted token anywhere. What holds here is narrower and
 * not fixable on our side: a Discord OAuth2 flow with the `bot` scope installs an
 * application into a server, but the credential that then calls the API is the
 * *application's* bot token, a property of the app rather than anything the
 * exchange returns — so a browser flow would end with the operator still copying
 * a token out of the developer portal. The `webhook.incoming` scope does return a
 * usable credential, and it is write-only to a single channel: it cannot read, so
 * it cannot serve the half of this that is triage.
 *
 * `auth.kind` is `header` rather than `bearer` because Discord's scheme word is
 * `Bot`, not `Bearer`, and a bearer credential is assembled as `Bearer <token>`
 * with no way to say otherwise. `header` writes the stored value into
 * `Authorization` verbatim, so the value the operator pastes carries its own
 * scheme — `Bot MTIz…`. That keeps the whole provider inside this folder at the
 * cost of a prefix somebody can forget, which is why the prompt label spells it
 * out and `troubleshooting` names it as the first thing to check.
 *
 * No `identity` block, and its absence is deliberate rather than an omission.
 * The probe sends `Authorization: Bearer <stored value>`, which for this
 * provider would be `Bearer Bot MTIz…` — a 401 and a null, after a network round
 * trip, every single connect. Naming the connection falls to the operator
 * instead. Re-running `connect` with the *same* label repairs the existing
 * connection rather than adding a second one, because `settleIdentity` matches
 * on the label; a scripted run passes `--display-name`.
 */
export const discord = defineProvider({
  id: 'discord',
  name: 'Discord',
  description:
    'Post announcements, read channels, and triage messages in the servers your bot has been added to, via the Discord v10 HTTP API.',
  connector: {
    kind: 'http',
    base_url: 'https://discord.com/api/v10',
    // Vendored, not fetched, and doubly so here: upstream is a public preview
    // Discord says may break without notice, and `connect` grants everything a
    // provider discovers. See `specs/vendor.ts`.
    openapi: specPath('discord.v10.json'),
    headers: { 'User-Agent': DISCORD_USER_AGENT },
  },
  auth: { kind: 'header', header: 'Authorization' },
  redact: DISCORD_REDACT,
  hints: DISCORD_HINTS,
  setup: {
    summary:
      'Discord authenticates an integration as an application, not as you. You create one in ' +
      'their developer portal, copy its bot token, and invite it to the servers you want ' +
      'reachable. Posts will carry an APP badge; the name and avatar on them are yours to set. ' +
      'You are asked for the token once.',
    docs: 'docs/detailed/setup/discord.md',
    docs_url: 'https://discord.com/developers/applications',
    steps: [
      'Open https://discord.com/developers/applications and choose "New Application". Name it whatever you want the posts to read as — this is the name people will see.',
      'On the General Information page, set the icon. That is the avatar posts will carry.',
      'Open the Bot tab. Set the username, then under "Privileged Gateway Intents" switch on MESSAGE CONTENT — without it every message you read comes back with an empty body, and nothing else will tell you why. An app in fewer than 10,000 servers can just toggle it; there is no review.',
      'Still on the Bot tab, choose "Reset Token" and copy what it shows you. Discord shows it once. Paste it below prefixed with the word Bot and a space, exactly as: Bot MTIzNDU2Nzg5.abcdef',
      'Turn off "Public Bot" on the same page unless you want strangers adding it to their servers.',
      'Now invite it. Take the Application ID from General Information and open: https://discord.com/oauth2/authorize?client_id=<application-id>&scope=bot&permissions=309774593088',
      'Pick a server you own and authorise. Those permission bits are exactly what the vendored operations need: view channels, send messages, manage messages (for pinning), read message history, add reactions, create public threads, send in threads, and manage webhooks. Repeat per server.',
      'A private channel needs the bot added to it as well — server-wide permissions do not reach a channel it cannot see.',
      'To rotate: "Reset Token" in the portal, then run: lanes link connect discord --replace',
    ],
    troubleshooting:
      'Discord refused the token. Check the prefix first — the stored value must begin with ' +
      '"Bot " and a token pasted bare is the usual cause of a 401 that names nothing. ' +
      'After that: a token invalidated by a later "Reset Token", or an application that was ' +
      'deleted. If calls authenticate but a channel 403s, the bot is in the server but not ' +
      'that channel, or the invite was authorised without the permissions above. If reads ' +
      'succeed and every message body is empty, the MESSAGE CONTENT intent is off. ' +
      'Reset the token at https://discord.com/developers/applications and re-run: ' +
      'lanes link connect discord --replace',
    prompts: [
      {
        key: 'token',
        label: 'Discord bot token, prefixed — Bot <token>',
        secret: true,
        scope: 'connection' as const,
      },
    ],
  },
});
