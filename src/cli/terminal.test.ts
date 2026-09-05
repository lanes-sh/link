import { afterEach, describe, expect, test } from 'bun:test';
import { columns, level, paint, style, width } from './terminal.ts';

/**
 * The environment is the injection point, so the tests set it.
 *
 * Every one of these restores what it touched. `bun test` runs a file in one
 * process, so a leaked `NO_COLOR` does not fail here — it fails somewhere else
 * entirely, which is the worst kind of failure to find.
 */
const TOUCHED = ['COLUMNS', 'NO_COLOR', 'FORCE_COLOR', 'TERM', 'COLORTERM', 'COLORFGBG'] as const;
const before = new Map(TOUCHED.map((key) => [key, process.env[key]] as const));

afterEach(() => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** Colour at all, so a role emits something to assert on. */
function forceColour(rung: '1' | '2' | '3'): void {
  delete process.env['NO_COLOR'];
  process.env['FORCE_COLOR'] = rung;
  process.env['TERM'] = 'xterm';
  delete process.env['COLORTERM'];
}

describe('how wide', () => {
  test('COLUMNS wins, because it is the only knob a test or a CI job has', () => {
    process.env['COLUMNS'] = '64';
    expect(columns()).toBe(64);
    expect(width()).toBe(63);
  });

  test('a terminal wider than the measure is clamped, so prose stays readable', () => {
    process.env['COLUMNS'] = '200';
    expect(width()).toBe(90);
  });

  test('a terminal narrower than the floor is clamped, so the arithmetic holds', () => {
    // Below this the rule length goes negative and `repeat` throws. Overflowing
    // into the emulator's own wrap is ugly; crashing is worse.
    process.env['COLUMNS'] = '20';
    expect(width()).toBe(40);
  });

  test('a nonsense COLUMNS is ignored rather than believed', () => {
    process.env['COLUMNS'] = 'wide';
    expect(columns()).toBe(80);
  });
});

describe('how much colour', () => {
  test('NO_COLOR silences every rung', () => {
    process.env['NO_COLOR'] = '1';
    process.env['COLORTERM'] = 'truecolor';
    expect(level()).toBe(0);
    expect(style.bold('x')).toBe('x');
    expect(paint.accent('x')).toBe('x');
  });

  test('a dumb terminal is not argued with', () => {
    process.env['FORCE_COLOR'] = '3';
    process.env['TERM'] = 'dumb';
    expect(level()).toBe(0);
  });

  test('truecolor is claimed by COLORTERM', () => {
    delete process.env['NO_COLOR'];
    process.env['FORCE_COLOR'] = '1';
    process.env['COLORTERM'] = 'truecolor';
    expect(level()).toBe(3);
  });

  test('256 is claimed by TERM', () => {
    forceColour('1');
    process.env['TERM'] = 'xterm-256color';
    expect(level()).toBe(2);
  });

  test('a plain terminal gets the sixteen it has always had', () => {
    forceColour('1');
    expect(level()).toBe(1);
    expect(paint.accent('x')).toContain('[32m');
  });
});

describe('the accent down the ladder', () => {
  test('truecolor spells the brand emerald out', () => {
    forceColour('3');
    delete process.env['COLORFGBG'];
    expect(paint.accent('x')).toContain('[38;2;16;185;129m');
  });

  test('256 falls to the nearest cube entry, not to a number chosen by eye', () => {
    forceColour('2');
    expect(paint.accent('x')).toContain('[38;5;36m');
    expect(paint.link('x')).toContain('[38;5;31m');
  });

  test('a terminal that declares a light background gets the light emerald', () => {
    forceColour('3');
    process.env['COLORFGBG'] = '0;15';
    expect(paint.accent('x')).toContain('[38;2;5;150;105m');
  });

  test('a terminal that declares a dark background gets the dark one', () => {
    forceColour('3');
    process.env['COLORFGBG'] = '15;0';
    expect(paint.accent('x')).toContain('[38;2;52;211;153m');
  });

  test('weight is not hue, so muted and strong survive a colourless terminal', () => {
    forceColour('1');
    expect(paint.muted('x')).toBe(style.dim('x'));
    expect(paint.strong('x')).toBe(style.bold('x'));
  });
});
