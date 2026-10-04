import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import {
  hasSameServarrServiceAuthority,
  runWithServarrServiceAdmission,
} from '@server/lib/serviceAdmission';
import type { SuwayomiSettings } from '@server/lib/settings';

/** The instance was removed, or its address or login changed. */
export class SuwayomiInstanceChangedError extends Error {
  constructor() {
    super('The Suwayomi instance changed during the operation.');
  }
}

/**
 * Copies an instance's settings. Take it before `getSuwayomiClient`, so a
 * change in between shows up as a mismatch instead of passing unnoticed.
 */
export const snapshotSuwayomiInstance = (
  id: number
): SuwayomiSettings | undefined => {
  const current = getExternalRuntimeConfig().suwayomi.find(
    (instance) => instance.id === id
  );
  return current ? structuredClone(current) : undefined;
};

/**
 * Runs a write under the instance's admission, the one settings changes take,
 * once its address and login still match the snapshot the reads used.
 * Every writer of an instance's library data goes through here.
 */
export const runWithSuwayomiInstanceAdmission = <Result>(
  snapshot: SuwayomiSettings,
  callback: () => Promise<Result>
): Promise<Result> =>
  runWithServarrServiceAdmission(
    [{ serviceType: 'suwayomi', serviceId: snapshot.id }],
    async () => {
      const current = getExternalRuntimeConfig().suwayomi.find(
        (instance) => instance.id === snapshot.id
      );
      if (!current || !hasSameServarrServiceAuthority(current, snapshot)) {
        throw new SuwayomiInstanceChangedError();
      }
      return callback();
    }
  );
