import { describe, expect, test } from 'bun:test';
import type { DeployConfig } from '#profile';
import { driverFor } from './drivers.ts';

/**
 * The one place a platform becomes a driver.
 *
 * Worth its own test because the failure it prevents is silent: before this,
 * `main.ts` imported the Cloud Run function by path, so the command's grammar
 * was generic while its behaviour was one vendor's. A driver that dispatches to
 * the wrong implementation, or to none, would look like a working deploy right
 * up to the point it rolled a revision somewhere unexpected.
 */

describe('driverFor', () => {
  test('returns the driver that declares the platform asked for', async () => {
    const driver = await driverFor('cloudrun');
    expect(driver.platform).toBe('cloudrun');
  });

  test('a platform with no driver is refused, and the message lists what exists', async () => {
    // Unreachable while the schema enum and this switch agree — and they are
    // edited by different hands at different times, so a platform that parses
    // but does not dispatch has to say so rather than return undefined into a
    // call chain.
    const rejected = driverFor('app-runner' as DeployConfig['platform']);
    await expect(rejected).rejects.toThrow(/No deployment driver for platform "app-runner".*cloudrun/s);
  });

  test('every driver exposes the tool a --dry-run plan is printed with', async () => {
    const driver = await driverFor('cloudrun');
    expect(driver.tool).toBeTruthy();
  });
});
