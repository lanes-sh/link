import { describe, expect, test } from 'bun:test';
import { assertEnvironmentMatches, environmentFrom } from './environment.ts';

/**
 * The guard that stops a staging deployment reading production.
 *
 * The Lanes API derives its stage configuration by overriding each secret
 * substitution individually, so a secret added without its override leaves
 * stage silently reading the prod one. Nothing warns, and two are already in
 * that state. For a form endpoint that misroutes a submission; for a workspace
 * holding OAuth refresh tokens it is somebody's mailbox.
 *
 * So a managed deployment derives everything from one environment name and
 * refuses to boot when what it derived disagrees. Refusing is the whole point:
 * a mismatch that logs a warning and serves anyway is the silent fallback with
 * an extra step.
 */

describe('reading the environment', () => {
  test('accepts the two names a deployment may carry', () => {
    expect(environmentFrom('prod')).toBe('prod');
    expect(environmentFrom('stage')).toBe('stage');
  });

  test('refuses anything else rather than assuming production', () => {
    // The dangerous default. An unset or misspelled variable resolving to
    // `prod` is how a staging revision ends up holding production's root.
    expect(() => environmentFrom(undefined)).toThrow(/environment/i);
    expect(() => environmentFrom('')).toThrow(/environment/i);
    expect(() => environmentFrom('production')).toThrow(/environment/i);
    expect(() => environmentFrom('staging')).toThrow(/environment/i);
  });
});

describe('matching a location to its environment', () => {
  const check = (environment: 'prod' | 'stage', value: string) =>
    assertEnvironmentMatches({ environment, what: 'LANES_LINK_HOME', value });

  test('a stage deployment accepts a location that names stage', () => {
    expect(() => check('stage', 'gs://lanes-link-managed-stage/workspaces')).not.toThrow();
    expect(() => check('stage', 'https://api-stage.example.com')).not.toThrow();
  });

  test('a stage deployment refuses a location that does not name stage', () => {
    // The failure this whole file exists for.
    expect(() => check('stage', 'gs://lanes-link-managed/workspaces')).toThrow(
      /LANES_LINK_HOME/,
    );
    expect(() => check('stage', 'https://api.example.com')).toThrow(/stage/i);
  });

  test('a prod deployment refuses a location that names stage', () => {
    // The mirror, and worth having: a production revision pointed at staging
    // storage serves an empty workspace and looks like data loss.
    expect(() => check('prod', 'gs://lanes-link-managed-stage/workspaces')).toThrow(
      /LANES_LINK_HOME/,
    );
  });

  test('a prod deployment accepts a location that names no environment', () => {
    expect(() => check('prod', 'gs://lanes-link-managed/workspaces')).not.toThrow();
    expect(() => check('prod', 'https://api.example.com')).not.toThrow();
  });

  test('names the location and both sides in the refusal', () => {
    // A boot failure is read in a log with no command line to inspect, so the
    // message carries what the operator would otherwise have to go and find.
    expect(() => check('stage', 'gs://lanes-link-managed/workspaces')).toThrow(
      /gs:\/\/lanes-link-managed\/workspaces/,
    );
  });
});
