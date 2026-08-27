import type { CustomAnswers } from './spec.ts';

/**
 * Reading what the operator said, in the shape the schema wants it.
 *
 * `values` is flag-keyed and every value arrived as a string or a list of them,
 * because argv has nothing else to offer. These four are the only places that
 * changes, so a field is read the same way wherever it is read.
 */

export const one = (answers: CustomAnswers, flag: string): string | undefined => {
  const value = answers.values[flag];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

export const many = (answers: CustomAnswers, flag: string): readonly string[] => {
  const value = answers.values[flag];
  return Array.isArray(value) ? value.filter((entry) => entry.length > 0) : [];
};

/**
 * `--strategy-option key=value` and `--authorize-param key=value`, repeated.
 *
 * Both untyped on purpose. A strategy's `options` are validated by the strategy
 * itself, which is the only thing that knows what it takes; an authorization
 * request's extra parameters are the vendor's vocabulary and not ours.
 */
export function pairs(answers: CustomAnswers, flag: string): Record<string, string> | undefined {
  const declared = many(answers, flag);
  if (declared.length === 0) return undefined;

  const parsed: Record<string, string> = {};

  for (const entry of declared) {
    const split = entry.indexOf('=');
    if (split < 1) {
      throw new Error(`--${flag} "${entry}" is not a setting. Write it as "key=value".`);
    }
    parsed[entry.slice(0, split).trim()] = entry.slice(split + 1).trim();
  }

  return parsed;
}

export function port(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`--${flag} must be a port between 1 and 65535, not "${value}".`);
  }
  return parsed;
}
