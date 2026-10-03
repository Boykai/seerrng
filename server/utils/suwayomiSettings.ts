import type {
  SuwayomiSettingsErrorCode,
  SuwayomiSettingsView,
} from '@server/interfaces/api/suwayomiInterfaces';
import type {
  SuwayomiSettings,
  SuwayomiSettingsAuthMode,
} from '@server/lib/settings';
import { REDACTED_SECRET } from '@server/utils/security';
import {
  MAX_SERVICE_ID,
  MAX_SERVICE_PORT,
  parseOptionalUrlBase,
  parseRequiredServiceString,
  parseServiceBoolean,
} from '@server/utils/servarrSettings';
import {
  buildServiceUrl,
  normalizeServiceHostname,
} from '@server/utils/serviceUrl';
import { parseOptionalNonNegativeInteger } from '@server/utils/validation';

export const SUWAYOMI_AUTH_MODES: readonly SuwayomiSettingsAuthMode[] = [
  'UI_LOGIN',
  'BASIC_AUTH',
  'NONE',
];
export const MAX_SUWAYOMI_INSTANCES = 1;
export const MAX_SUWAYOMI_USERNAME_LENGTH = 512;
export const MAX_SUWAYOMI_PASSWORD_LENGTH = 1024;
export const MAX_SUWAYOMI_ALLOWLIST_SOURCES = 200;
export const MAX_SUWAYOMI_PREFERRED_LANGUAGES = 50;
export const MAX_SUWAYOMI_SCANLATORS = 50;
const MAX_SCANLATOR_LENGTH = 128;
// Canonical decimal digits within the signed 64-bit range of source IDs.
const SOURCE_ID_PATTERN = /^[1-9]\d{0,18}$/;
const MAX_SOURCE_ID = '9223372036854775807';
const LANGUAGE_PATTERN = /^[A-Za-z0-9_-]{1,35}$/;
// eslint-disable-next-line no-control-regex
const CREDENTIAL_LINE_BREAKS = /[\r\n\0]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

export const SUWAYOMI_SETTINGS_MESSAGES = {
  SUWAYOMI_CREDENTIALS_REQUIRED:
    'Enter the Suwayomi username and password for this authentication mode.',
  SUWAYOMI_PASSWORD_REQUIRED:
    'Enter the password again: the server address or username changed.',
  SUWAYOMI_INSTANCE_LIMIT: 'Only one Suwayomi server can be configured.',
} as const;

export type SuwayomiParseResult<T> =
  { value: T } | { error: string; code: SuwayomiSettingsErrorCode };

export type SuwayomiOrigin = Pick<
  SuwayomiSettings,
  'hostname' | 'port' | 'useSsl' | 'baseUrl'
>;

export type SuwayomiSettingsInput = Omit<SuwayomiSettings, 'id' | 'isDefault'>;

export type SuwayomiConnectionTestInput = SuwayomiOrigin & {
  id?: number;
  username: string;
  password: string;
  requireCbz: boolean;
  sourceAllowlist: string[];
};

const invalid = (error: string) => ({
  error,
  code: 'SUWAYOMI_INVALID_SETTINGS' as const,
});

export const buildSuwayomiUrl = (settings: SuwayomiOrigin): string =>
  buildServiceUrl({
    useSsl: settings.useSsl,
    hostname: settings.hostname,
    port: settings.port,
    urlBase: settings.baseUrl,
  });

const parseOrigin = (
  settings: Record<string, unknown>
): SuwayomiParseResult<SuwayomiOrigin> => {
  const hostname = parseRequiredServiceString(settings.hostname, 'hostname');
  if ('error' in hostname) return invalid(hostname.error);
  const normalizedHostname = normalizeServiceHostname(hostname.value);
  if (!normalizedHostname) {
    return invalid('hostname is invalid.');
  }

  const port = parseOptionalNonNegativeInteger(settings.port, MAX_SERVICE_PORT);
  if (port === undefined || port < 1) {
    return invalid('port is invalid.');
  }

  const baseUrl = parseOptionalUrlBase(settings.baseUrl);
  if ('error' in baseUrl) return invalid(baseUrl.error);
  const useSsl = parseServiceBoolean(settings.useSsl, 'useSsl');
  if ('error' in useSsl) return invalid(useSsl.error);

  const origin = {
    hostname: normalizedHostname,
    port,
    useSsl: useSsl.value,
    baseUrl: baseUrl.value,
  };
  try {
    new URL(buildSuwayomiUrl(origin));
  } catch {
    // For example a hostname that already carries a port.
    return invalid('hostname is invalid.');
  }
  return { value: origin };
};

// Credentials are sent exactly as entered, so they are not trimmed.
const parseCredential = (
  value: unknown,
  fieldName: string,
  maxLength: number
): SuwayomiParseResult<string> => {
  if (value === undefined || value === null) {
    return { value: '' };
  }
  if (typeof value !== 'string') {
    return invalid(`${fieldName} must be a string.`);
  }
  if (value.length > maxLength) {
    return invalid(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return CREDENTIAL_LINE_BREAKS.test(value)
    ? invalid(`${fieldName} contains an invalid character.`)
    : { value };
};

const parseCredentials = (
  settings: Record<string, unknown>
): SuwayomiParseResult<{ username: string; password: string }> => {
  const username = parseCredential(
    settings.username,
    'username',
    MAX_SUWAYOMI_USERNAME_LENGTH
  );
  if ('error' in username) return username;
  const password = parseCredential(
    settings.password,
    'password',
    MAX_SUWAYOMI_PASSWORD_LENGTH
  );
  if ('error' in password) return password;
  return { value: { username: username.value, password: password.value } };
};

const parseList = (
  value: unknown,
  fieldName: string,
  maxEntries: number,
  parseEntry: (entry: unknown) => string | undefined
): SuwayomiParseResult<string[]> => {
  if (value === undefined || value === null) {
    return { value: [] };
  }
  if (!Array.isArray(value)) {
    return invalid(`${fieldName} must be an array.`);
  }
  if (value.length > maxEntries) {
    return invalid(`${fieldName} must have ${maxEntries} entries or fewer.`);
  }
  const entries = new Set<string>();
  for (const entry of value) {
    const parsed = parseEntry(entry);
    if (parsed === undefined) {
      return invalid(`${fieldName} contains an invalid value.`);
    }
    entries.add(parsed);
  }
  return { value: [...entries] };
};

// The built-in local source ("0") is never part of the allowlist.
const parseSourceId = (entry: unknown): string | undefined =>
  typeof entry === 'string' &&
  SOURCE_ID_PATTERN.test(entry) &&
  (entry.length < MAX_SOURCE_ID.length || entry <= MAX_SOURCE_ID)
    ? entry
    : undefined;

const parseLanguage = (entry: unknown): string | undefined =>
  typeof entry === 'string' && LANGUAGE_PATTERN.test(entry) ? entry : undefined;

const parseScanlator = (entry: unknown): string | undefined => {
  if (typeof entry !== 'string') {
    return undefined;
  }
  const trimmed = entry.trim();
  return trimmed &&
    trimmed.length <= MAX_SCANLATOR_LENGTH &&
    !CONTROL_CHARACTERS.test(trimmed)
    ? trimmed
    : undefined;
};

const parseSourceAllowlist = (value: unknown) =>
  parseList(
    value,
    'sourceAllowlist',
    MAX_SUWAYOMI_ALLOWLIST_SOURCES,
    parseSourceId
  );

const parseRequireCbz = (value: unknown): SuwayomiParseResult<boolean> => {
  if (value === undefined || value === null) {
    return { value: true };
  }
  return typeof value === 'boolean'
    ? { value }
    : invalid('requireCbz must be a boolean.');
};

const asRecord = (body: unknown): Record<string, unknown> | undefined =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;

/**
 * SeerrNG's own rule: a mode that signs in needs at least one credential.
 * Returns the error, or undefined when the credentials are acceptable.
 */
export const checkSuwayomiCredentials = (
  authMode: SuwayomiSettingsAuthMode,
  username: string,
  password: string
): { error: string; code: 'SUWAYOMI_CREDENTIALS_REQUIRED' } | undefined =>
  authMode !== 'NONE' && !username && !password
    ? {
        error: SUWAYOMI_SETTINGS_MESSAGES.SUWAYOMI_CREDENTIALS_REQUIRED,
        code: 'SUWAYOMI_CREDENTIALS_REQUIRED',
      }
    : undefined;

/**
 * Parses a create or update body. The server assigns `id` and `isDefault`, so
 * both are ignored here.
 */
export const parseSuwayomiSettings = (
  body: unknown
): SuwayomiParseResult<SuwayomiSettingsInput> => {
  const settings = asRecord(body);
  if (!settings) {
    return invalid('settings must be an object.');
  }

  const name = parseRequiredServiceString(settings.name, 'name');
  if ('error' in name) return invalid(name.error);
  const origin = parseOrigin(settings);
  if ('error' in origin) return origin;

  const authMode = SUWAYOMI_AUTH_MODES.find(
    (mode) => mode === settings.authMode
  );
  if (!authMode) {
    return invalid('authMode must be UI_LOGIN, BASIC_AUTH or NONE.');
  }
  const credentials = parseCredentials(settings);
  if ('error' in credentials) return credentials;
  const missingCredentials = checkSuwayomiCredentials(
    authMode,
    credentials.value.username,
    credentials.value.password
  );
  if (missingCredentials) return missingCredentials;

  const sourceAllowlist = parseSourceAllowlist(settings.sourceAllowlist);
  if ('error' in sourceAllowlist) return sourceAllowlist;
  const preferredLanguages = parseList(
    settings.preferredLanguages,
    'preferredLanguages',
    MAX_SUWAYOMI_PREFERRED_LANGUAGES,
    parseLanguage
  );
  if ('error' in preferredLanguages) return preferredLanguages;
  const scanlatorPreference = parseList(
    settings.scanlatorPreference,
    'scanlatorPreference',
    MAX_SUWAYOMI_SCANLATORS,
    parseScanlator
  );
  if ('error' in scanlatorPreference) return scanlatorPreference;
  const requireCbz = parseRequireCbz(settings.requireCbz);
  if ('error' in requireCbz) return requireCbz;

  return {
    value: {
      name: name.value,
      ...origin.value,
      authMode,
      ...credentials.value,
      sourceAllowlist: sourceAllowlist.value,
      preferredLanguages: preferredLanguages.value,
      scanlatorPreference: scanlatorPreference.value,
      requireCbz: requireCbz.value,
    },
  };
};

/**
 * Parses a connection-test body. The test detects the authentication mode
 * itself, so `authMode` and the fields that only affect requests are ignored.
 */
export const parseSuwayomiConnectionTest = (
  body: unknown
): SuwayomiParseResult<SuwayomiConnectionTestInput> => {
  const settings = asRecord(body);
  if (!settings) {
    return invalid('settings must be an object.');
  }

  let id: number | undefined;
  if (settings.id !== undefined && settings.id !== null) {
    id = parseOptionalNonNegativeInteger(settings.id, MAX_SERVICE_ID);
    if (id === undefined) {
      return invalid('id is invalid.');
    }
  }
  const origin = parseOrigin(settings);
  if ('error' in origin) return origin;
  const credentials = parseCredentials(settings);
  if ('error' in credentials) return credentials;
  const sourceAllowlist = parseSourceAllowlist(settings.sourceAllowlist);
  if ('error' in sourceAllowlist) return sourceAllowlist;
  const requireCbz = parseRequireCbz(settings.requireCbz);
  if ('error' in requireCbz) return requireCbz;

  return {
    value: {
      id,
      ...origin.value,
      ...credentials.value,
      requireCbz: requireCbz.value,
      sourceAllowlist: sourceAllowlist.value,
    },
  };
};

const hasSameSuwayomiLogin = (
  incoming: SuwayomiOrigin & { username: string },
  stored: SuwayomiOrigin & { username: string }
): boolean =>
  incoming.useSsl === stored.useSsl &&
  incoming.hostname === stored.hostname &&
  incoming.port === stored.port &&
  (incoming.baseUrl ?? '') === (stored.baseUrl ?? '') &&
  incoming.username === stored.username;

/**
 * Turns `[REDACTED]` back into the stored password. The stored credential
 * can control Suwayomi, so it is only reused for the same address and
 * username; anything else needs the password typed again.
 */
export const resolveSuwayomiPassword = (
  incoming: SuwayomiOrigin & { username: string; password: string },
  stored: SuwayomiSettings | undefined
): SuwayomiParseResult<string> => {
  if (incoming.password !== REDACTED_SECRET) {
    return { value: incoming.password };
  }
  return stored && hasSameSuwayomiLogin(incoming, stored)
    ? { value: stored.password }
    : {
        error: SUWAYOMI_SETTINGS_MESSAGES.SUWAYOMI_PASSWORD_REQUIRED,
        code: 'SUWAYOMI_PASSWORD_REQUIRED',
      };
};

/** Builds the API view by hand so no stored secret can reach a response. */
export const suwayomiSettingsView = (
  settings: SuwayomiSettings
): SuwayomiSettingsView => ({
  id: settings.id,
  name: settings.name,
  hostname: settings.hostname,
  port: settings.port,
  useSsl: settings.useSsl === true,
  baseUrl: settings.baseUrl ?? '',
  isDefault: settings.isDefault === true,
  authMode: settings.authMode,
  username: settings.username ?? '',
  password: settings.password ? REDACTED_SECRET : '',
  sourceAllowlist: [...(settings.sourceAllowlist ?? [])],
  preferredLanguages: [...(settings.preferredLanguages ?? [])],
  scanlatorPreference: [...(settings.scanlatorPreference ?? [])],
  requireCbz: settings.requireCbz !== false,
});
