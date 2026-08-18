/**
 * Reject credential values that have been written into a config file.
 *
 * Config carries `_ref` pointers into the credential store; it never carries a
 * value. This module is what turns that from an intention into a check, and it
 * runs on every load and before every CLI write, so a config file cannot become
 * a place secrets accumulate.
 *
 * Findings name the exact path (`oauth_apps.google.client_secret`) because "your
 * config contains a secret" is not actionable on a file with fifty keys.
 *
 * Deliberately biased toward false negatives over false positives. A rule that
 * rejects a legitimate display name makes the tool unusable, and this is a
 * second line of defence — `.gitignore` is the first, and the credential store
 * is what makes the whole class of mistake unnecessary.
 */

export interface SecretFinding {
  /** Dotted path, with array indices: `connections[0].credential_ref`. */
  readonly path: string;
  readonly rule: string;
  readonly detail: string;
}

/** Vendor prefixes that are never anything but a live credential. */
const CREDENTIAL_PREFIXES: ReadonlyArray<{ prefix: string; label: string }> = [
  { prefix: 'sk-', label: 'an OpenAI-style secret key' },
  { prefix: 'xoxb-', label: 'a Slack bot token' },
  { prefix: 'xoxp-', label: 'a Slack user token' },
  { prefix: 'xapp-', label: 'a Slack app token' },
  { prefix: 'ya29.', label: 'a Google OAuth access token' },
  { prefix: 'ghp_', label: 'a GitHub personal access token' },
  { prefix: 'gho_', label: 'a GitHub OAuth token' },
  { prefix: 'github_pat_', label: 'a GitHub fine-grained token' },
  { prefix: 'AKIA', label: 'an AWS access key id' },
  { prefix: 'AIza', label: 'a Google API key' },
  { prefix: 'llk_', label: 'a Lanes Link profile token' },
  { prefix: '1//', label: 'a Google refresh token' },
];

const PRIVATE_KEY_BLOCK = /-----BEGIN[ A-Z]*PRIVATE KEY-----/;

/**
 * Key names that must hold a reference rather than a value.
 *
 * A key ending in `_ref` is exempt: `client_secret_ref` is exactly what config
 * is supposed to contain, while `client_secret` is exactly what it must not.
 */
const VALUE_BEARING_KEY = /(?:^|_)(secret|token|password|passwd|apikey|credential)$|_key$/;

/** A single opaque token — no spaces, the shape credentials actually take. */
const OPAQUE_TOKEN = /^[A-Za-z0-9_\-+/=.]{24,}$/;

export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function characterClasses(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes++;
  if (/[A-Z]/.test(value)) classes++;
  if (/[0-9]/.test(value)) classes++;
  return classes;
}

/**
 * Does this look like a random blob rather than a path, name, or identifier?
 *
 * Requiring all three of length, mixed character classes, and high entropy is
 * what keeps `./data/personal.credentials.enc` (no uppercase, no digits) and
 * `google/client_secret` (lowercase only) from being flagged, while catching a
 * base64 or hex credential.
 */
function looksHighEntropy(value: string): boolean {
  return (
    OPAQUE_TOKEN.test(value) &&
    characterClasses(value) >= 3 &&
    shannonEntropy(value) >= 3.5 &&
    !/^https?:/i.test(value)
  );
}

function inspectValue(path: string, key: string, value: string): SecretFinding | null {
  if (value.length === 0) return null;

  if (PRIVATE_KEY_BLOCK.test(value)) {
    return { path, rule: 'private-key-block', detail: 'contains an inline private key block' };
  }

  for (const { prefix, label } of CREDENTIAL_PREFIXES) {
    if (value.startsWith(prefix)) {
      return {
        path,
        rule: 'credential-prefix',
        detail: `starts with "${prefix}", which identifies ${label}`,
      };
    }
  }

  // A key that names a credential must carry a reference, not a value —
  // regardless of how innocuous the value looks.
  if (!key.endsWith('_ref') && VALUE_BEARING_KEY.test(key)) {
    return {
      path,
      rule: 'value-bearing-key',
      detail:
        `"${key}" names a credential, so it must hold a reference rather than a value. ` +
        `Use "${key}_ref" pointing at the credential store, e.g. "google/${key}".`,
    };
  }

  if (looksHighEntropy(value)) {
    return {
      path,
      rule: 'high-entropy',
      detail: `is a ${value.length}-character high-entropy string, which looks like a credential`,
    };
  }

  return null;
}

/** Walk a parsed config and report every credential-shaped value in it. */
export function findSecrets(value: unknown, path = '', key = ''): SecretFinding[] {
  if (typeof value === 'string') {
    const finding = inspectValue(path, key, value);
    return finding ? [finding] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findSecrets(item, `${path}[${index}]`, key));
  }

  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([childKey, childValue]) =>
      findSecrets(childValue, path ? `${path}.${childKey}` : childKey, childKey),
    );
  }

  return [];
}

export function formatSecretFindings(findings: readonly SecretFinding[]): string {
  const lines = findings.map((finding) => `  ${finding.path} ${finding.detail}`);
  return (
    `Configuration must not contain credential values, only "_ref" pointers into the credential store.\n` +
    `${findings.length === 1 ? 'This value' : 'These values'} looked like a credential:\n` +
    `${lines.join('\n')}\n\n` +
    `Move the value into the credential store and reference it instead. ` +
    `If this is a false positive, rename the key or shorten the value — ` +
    `there is deliberately no way to suppress this check.`
  );
}
