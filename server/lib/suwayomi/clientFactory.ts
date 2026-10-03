import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type {
  SuwayomiAPIOptions,
  SuwayomiAuthConfig,
} from '@server/api/suwayomi/types';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import type { SuwayomiSettings } from '@server/lib/settings';
import { buildSuwayomiUrl } from '@server/utils/suwayomiSettings';
import { createHmac, randomBytes } from 'node:crypto';

export type SuwayomiConnectionSettings = Pick<
  SuwayomiSettings,
  | 'hostname'
  | 'port'
  | 'useSsl'
  | 'baseUrl'
  | 'authMode'
  | 'username'
  | 'password'
>;

/**
 * Connection-test clients turn `warnInsecureAuthMode` off: their mode is a
 * guess until detection finishes, and the stored client must still warn.
 */
export type SuwayomiClientOptions = Pick<
  SuwayomiAPIOptions,
  'warnInsecureAuthMode'
>;

/** Sends credentials only the way the stored mode says; never another way. */
export const buildSuwayomiAuth = (
  settings: Pick<SuwayomiSettings, 'authMode' | 'username' | 'password'>
): SuwayomiAuthConfig => {
  switch (settings.authMode) {
    case 'NONE':
      return { mode: 'NONE' };
    case 'UI_LOGIN':
    case 'BASIC_AUTH':
      if (!settings.username && !settings.password) {
        throw new SuwayomiError('INVALID_ARGUMENT', 'configure');
      }
      return {
        mode: settings.authMode,
        username: settings.username ?? '',
        password: settings.password ?? '',
      };
    default:
      throw new SuwayomiError('AUTH_MODE_UNSUPPORTED', 'configure');
  }
};

/** Builds a client that is never cached, for example for a connection test. */
export const createSuwayomiClient = (
  settings: SuwayomiConnectionSettings,
  options: SuwayomiClientOptions = {}
): SuwayomiAPI =>
  new SuwayomiAPI({
    url: buildSuwayomiUrl(settings),
    auth: buildSuwayomiAuth(settings),
    ...options,
  });

// Keyed by a random per-process secret so the cache never holds a password.
const fingerprintKey = randomBytes(32);
const clients = new Map<number, { fingerprint: string; client: SuwayomiAPI }>();

const authorityFingerprint = (settings: SuwayomiConnectionSettings): string =>
  createHmac('sha256', fingerprintKey)
    .update(
      JSON.stringify([
        settings.useSsl === true,
        settings.hostname,
        settings.port,
        settings.baseUrl ?? '',
        settings.authMode,
        settings.username ?? '',
        settings.password ?? '',
      ])
    )
    .digest('base64url');

/**
 * Returns the client for a configured Suwayomi instance: the given ID, or the
 * default instance (else the first) when no ID is given. Returns undefined
 * when no such instance exists. This is the only way to get a client for a
 * stored instance.
 *
 * Each call re-reads the runtime configuration and reuses the cached client
 * only while the instance's address and credentials are unchanged, so tokens
 * never cross to another server or login. Callers get one client per job run
 * or per request, never one per item.
 */
export const getSuwayomiClient = (id?: number): SuwayomiAPI | undefined => {
  const instances = getExternalRuntimeConfig().suwayomi;
  const settings =
    id === undefined
      ? (instances.find((instance) => instance.isDefault) ?? instances[0])
      : instances.find((instance) => instance.id === id);
  if (!settings) {
    return undefined;
  }

  const fingerprint = authorityFingerprint(settings);
  const cached = clients.get(settings.id);
  if (cached?.fingerprint === fingerprint) {
    return cached.client;
  }
  clients.delete(settings.id);
  const client = createSuwayomiClient(settings);
  clients.set(settings.id, { fingerprint, client });
  return client;
};

/** Drops cached clients (all of them when no ID is given) after a change. */
export const invalidateSuwayomiClients = (id?: number): void => {
  if (id === undefined) {
    clients.clear();
  } else {
    clients.delete(id);
  }
};
