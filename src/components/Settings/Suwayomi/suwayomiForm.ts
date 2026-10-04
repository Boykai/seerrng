import {
  authModeMessages,
  errorMessages,
  warningMessages,
  type SuwayomiErrorCode,
} from '@app/components/Settings/Suwayomi/messages';
import type {
  SuwayomiContentWarning,
  SuwayomiDetectedAuthMode,
} from '@server/api/suwayomi/types';
import type {
  SuwayomiConnectionTestRequest,
  SuwayomiConnectionTestSource,
  SuwayomiConnectionTestWarning,
  SuwayomiConnectionTestWarningCode,
  SuwayomiSettingsRequest,
  SuwayomiSettingsView,
} from '@server/interfaces/api/suwayomiInterfaces';
import type { SuwayomiSettingsAuthMode } from '@server/lib/settings';
import {
  buildServiceUrl,
  normalizeServiceHostname,
  normalizeUrlBase,
} from '@server/utils/serviceUrl';
import type { IntlShape, MessageDescriptor } from 'react-intl';

// Mirrors the limits the settings API enforces.
export const SUWAYOMI_DEFAULT_PORT = 4567;
export const SUWAYOMI_MAX_TEXT_LENGTH = 512;
export const SUWAYOMI_MAX_PASSWORD_LENGTH = 1024;
export const SUWAYOMI_MAX_SOURCES = 200;
export const SUWAYOMI_MAX_LANGUAGES = 50;
export const SUWAYOMI_MAX_SCANLATORS = 50;
export const SUWAYOMI_MAX_SCANLATOR_LENGTH = 128;

const SOURCE_ID_PATTERN = /^[1-9]\d{0,18}$/;
const MAX_SOURCE_ID = '9223372036854775807';
const LANGUAGE_PATTERN = /^[A-Za-z0-9_-]{1,35}$/;
const PORT_PATTERN = /^\d{1,5}$/;
const VERSION_PATTERN = /^[\w.+-]{1,64}$/;
const LINE_BREAKS = /[\r\n\0]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const CONTENT_WARNINGS: ReadonlySet<unknown> = new Set<SuwayomiContentWarning>([
  'SAFE',
  'MIXED',
  'NSFW',
  'UNKNOWN',
]);

export interface SuwayomiFormValues {
  name: string;
  hostname: string;
  port: number | string;
  useSsl: boolean;
  baseUrl: string;
  username: string;
  password: string;
  requireCbz: boolean;
  sourceAllowlist: string[];
  preferredLanguages: string;
  scanlatorPreference: string;
}

type FormField = keyof SuwayomiFormValues;

// The last test no longer describes the form once one of these changes.
const VALIDATION_FIELDS: ReadonlySet<FormField> = new Set<FormField>([
  'useSsl',
  'hostname',
  'port',
  'baseUrl',
  'username',
  'password',
  'requireCbz',
]);

// The API replays a stored password only to the same address and username.
const LOGIN_FIELDS: ReadonlySet<FormField> = new Set<FormField>([
  'useSsl',
  'hostname',
  'port',
  'baseUrl',
  'username',
]);

export const resetsValidation = (field: FormField): boolean =>
  VALIDATION_FIELDS.has(field);

export const clearsStoredPassword = (field: FormField): boolean =>
  LOGIN_FIELDS.has(field);

const hasOwn = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

export const isValidSourceId = (id: unknown): id is string =>
  typeof id === 'string' &&
  SOURCE_ID_PATTERN.test(id) &&
  (id.length < MAX_SOURCE_ID.length || id <= MAX_SOURCE_ID);

export const suwayomiFormValues = (
  view: SuwayomiSettingsView | null
): SuwayomiFormValues => ({
  name: view?.name ?? '',
  hostname: view?.hostname ?? '',
  port: view?.port ?? SUWAYOMI_DEFAULT_PORT,
  useSsl: view?.useSsl ?? false,
  baseUrl: view?.baseUrl ?? '',
  username: view?.username ?? '',
  password: view?.password ?? '',
  requireCbz: view?.requireCbz ?? true,
  sourceAllowlist: view?.sourceAllowlist.filter(isValidSourceId) ?? [],
  preferredLanguages: view?.preferredLanguages.join(', ') ?? '',
  scanlatorPreference: view?.scanlatorPreference.join('\n') ?? '',
});

export const isValidPort = (port: unknown): boolean => {
  const text = typeof port === 'number' ? String(port) : port;
  if (typeof text !== 'string' || !PORT_PATTERN.test(text.trim())) {
    return false;
  }
  const value = Number(text);
  return value >= 1 && value <= 65535;
};

export const isValidHostname = ({
  hostname,
  useSsl,
  port,
  baseUrl,
}: {
  hostname?: string;
  useSsl?: boolean;
  port?: unknown;
  baseUrl?: string;
}): boolean => {
  const value = hostname?.trim() ?? '';
  if (
    !value ||
    (hostname?.length ?? 0) > SUWAYOMI_MAX_TEXT_LENGTH ||
    !normalizeServiceHostname(value)
  ) {
    return false;
  }
  try {
    // A hostname that already carries a port builds an invalid address.
    new URL(
      buildServiceUrl({
        useSsl,
        hostname: value,
        port: isValidPort(port) ? Number(port) : SUWAYOMI_DEFAULT_PORT,
        urlBase: baseUrl,
      })
    );
    return true;
  } catch {
    return false;
  }
};

export const isValidUrlBase = (baseUrl?: string): boolean =>
  !baseUrl?.trim() ||
  (baseUrl.length <= SUWAYOMI_MAX_TEXT_LENGTH &&
    normalizeUrlBase(baseUrl) !== '');

export const hasLineBreak = (value?: string): boolean =>
  LINE_BREAKS.test(value ?? '');

const parseList = (value: string | undefined, separator: string) => [
  ...new Set(
    (value ?? '')
      .split(separator)
      .map((entry) => entry.trim())
      .filter(Boolean)
  ),
];

export const parseLanguages = (value?: string): string[] =>
  parseList(value, ',');

export const parseScanlators = (value?: string): string[] =>
  parseList(value, '\n');

export const isValidLanguageList = (value?: string): boolean => {
  const languages = parseLanguages(value);
  return (
    languages.length <= SUWAYOMI_MAX_LANGUAGES &&
    languages.every((language) => LANGUAGE_PATTERN.test(language))
  );
};

export const isValidScanlatorList = (value?: string): boolean => {
  const scanlators = parseScanlators(value);
  return (
    scanlators.length <= SUWAYOMI_MAX_SCANLATORS &&
    scanlators.every(
      (scanlator) =>
        scanlator.length <= SUWAYOMI_MAX_SCANLATOR_LENGTH &&
        !CONTROL_CHARACTERS.test(scanlator)
    )
  );
};

/** The test body: the connection fields only, plus `id` when editing. */
export const buildTestRequest = (
  values: SuwayomiFormValues,
  id?: number
): SuwayomiConnectionTestRequest => ({
  ...(id === undefined ? {} : { id }),
  hostname: values.hostname.trim(),
  port: Number(values.port),
  useSsl: values.useSsl,
  baseUrl: values.baseUrl.trim(),
  username: values.username,
  password: values.password,
  requireCbz: values.requireCbz,
  sourceAllowlist: [...values.sourceAllowlist],
});

/** The save body. The API assigns `id` and `isDefault` and rejects both. */
export const buildSaveRequest = (
  values: SuwayomiFormValues,
  authMode: SuwayomiSettingsAuthMode
): SuwayomiSettingsRequest => ({
  name: values.name.trim(),
  hostname: values.hostname.trim(),
  port: Number(values.port),
  useSsl: values.useSsl,
  baseUrl: values.baseUrl.trim(),
  authMode,
  username: values.username,
  password: values.password,
  sourceAllowlist: [...values.sourceAllowlist],
  preferredLanguages: parseLanguages(values.preferredLanguages),
  scanlatorPreference: parseScanlators(values.scanlatorPreference),
  requireCbz: values.requireCbz,
});

/** Selecting appends (lowest priority); deselecting removes. */
export const toggleSourceId = (
  selected: readonly string[],
  id: string
): string[] => {
  if (selected.includes(id)) {
    return selected.filter((entry) => entry !== id);
  }
  return isValidSourceId(id) && selected.length < SUWAYOMI_MAX_SOURCES
    ? [...selected, id]
    : [...selected];
};

export interface SuwayomiSourceEntry {
  id: string;
  /** Undefined before a test, or when the test did not list the source. */
  source?: SuwayomiConnectionTestSource;
  /** 1-based position in the allowlist, for selected sources. */
  priority?: number;
}

/** Selected sources first, by priority; then the rest by display name. */
export const orderSourceEntries = (
  sources: readonly SuwayomiConnectionTestSource[] | undefined,
  selected: readonly string[]
): SuwayomiSourceEntry[] => {
  const byId = new Map(
    (sources ?? [])
      .filter((source) => isValidSourceId(source.id))
      .map((source) => [source.id, source])
  );
  const chosen = new Set(selected);
  return [
    ...selected.map((id, index) => ({
      id,
      source: byId.get(id),
      priority: index + 1,
    })),
    ...[...byId.values()]
      .filter((source) => !chosen.has(source.id))
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((source) => ({ id: source.id, source })),
  ];
};

export const filterSourceEntries = (
  entries: SuwayomiSourceEntry[],
  query: string
): SuwayomiSourceEntry[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return entries;
  }
  return entries.filter(({ id, source }) =>
    (source ? [source.displayName, source.name, source.lang] : [id]).some(
      (text) => text.toLowerCase().includes(needle)
    )
  );
};

/** Whether the language needs a badge: the display name may already show it. */
export const showsSourceLanguage = (
  source: SuwayomiConnectionTestSource
): boolean => {
  const lang = source.lang.trim().toLowerCase();
  return (
    !!lang &&
    !source.displayName
      .toLowerCase()
      .split(/[^a-z0-9-]+/)
      .includes(lang)
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const responseData = (error: unknown): Record<string, unknown> | undefined => {
  const response = isRecord(error) ? error.response : undefined;
  const data = isRecord(response) ? response.data : undefined;
  return isRecord(data) ? data : undefined;
};

export interface SuwayomiErrorBody {
  code?: string;
  /** The API's fixed English text, kept only alongside a code. */
  message?: string;
}

/** Reads `code` and its fixed `message`; nothing else from the response. */
export const readSuwayomiError = (error: unknown): SuwayomiErrorBody => {
  const data = responseData(error);
  if (typeof data?.code !== 'string' || !data.code) {
    return {};
  }
  return {
    code: data.code,
    message: typeof data.message === 'string' ? data.message : undefined,
  };
};

export const isKnownErrorCode = (code?: string): code is SuwayomiErrorCode =>
  !!code && hasOwn(errorMessages, code);

/** A known code's text, else the API's fixed message, else the fallback. */
export const describeSuwayomiError = (
  intl: IntlShape,
  { code, message }: SuwayomiErrorBody,
  fallback: MessageDescriptor
): string =>
  isKnownErrorCode(code)
    ? intl.formatMessage(errorMessages[code])
    : code && message
      ? message
      : intl.formatMessage(fallback);

export const isSettingsAuthMode = (
  mode?: string
): mode is SuwayomiSettingsAuthMode =>
  mode === 'UI_LOGIN' || mode === 'BASIC_AUTH' || mode === 'NONE';

export const authModeBadgeType: Record<
  SuwayomiDetectedAuthMode,
  'success' | 'warning' | 'danger' | 'default'
> = {
  UI_LOGIN: 'success',
  BASIC_AUTH: 'warning',
  NONE: 'danger',
  SIMPLE_LOGIN: 'warning',
  LOGIN_REQUIRED: 'default',
};

export interface SuwayomiTestDiagnostics {
  authMode?: SuwayomiDetectedAuthMode;
  version?: string;
  warnings: SuwayomiConnectionTestWarning[];
}

/** Keeps the known diagnostics of a test response, in the API's order. */
export const readTestDiagnostics = (data: unknown): SuwayomiTestDiagnostics => {
  const body = isRecord(data) ? data : {};
  const authMode =
    typeof body.authMode === 'string' && hasOwn(authModeMessages, body.authMode)
      ? (body.authMode as SuwayomiDetectedAuthMode)
      : undefined;
  const version =
    typeof body.version === 'string' && VERSION_PATTERN.test(body.version)
      ? body.version
      : undefined;
  const warnings = (Array.isArray(body.warnings) ? body.warnings : [])
    .filter(
      (warning): warning is Record<string, unknown> =>
        isRecord(warning) &&
        typeof warning.code === 'string' &&
        hasOwn(warningMessages, warning.code)
    )
    .map((warning) => ({
      code: warning.code as SuwayomiConnectionTestWarningCode,
      count:
        typeof warning.count === 'number' && Number.isInteger(warning.count)
          ? warning.count
          : undefined,
      sourceIds: Array.isArray(warning.sourceIds)
        ? warning.sourceIds.filter(isValidSourceId)
        : undefined,
    }));
  return { authMode, version, warnings };
};

/** The sources a successful test listed, without malformed entries. */
export const readTestSources = (
  data: unknown
): SuwayomiConnectionTestSource[] =>
  (isRecord(data) && Array.isArray(data.sources) ? data.sources : []).flatMap(
    (source: unknown): SuwayomiConnectionTestSource[] =>
      isRecord(source) &&
      isValidSourceId(source.id) &&
      typeof source.name === 'string' &&
      typeof source.displayName === 'string' &&
      typeof source.lang === 'string'
        ? [
            {
              id: source.id,
              name: source.name,
              displayName: source.displayName,
              lang: source.lang,
              contentWarning: CONTENT_WARNINGS.has(source.contentWarning)
                ? (source.contentWarning as SuwayomiContentWarning)
                : 'UNKNOWN',
              hasUpdate: source.hasUpdate === true,
              isObsolete: source.isObsolete === true,
            },
          ]
        : []
  );

/** The 502 body of a test that reached a verdict other than success. */
export const readTestFailure = (
  error: unknown
): SuwayomiTestDiagnostics | undefined => {
  const data = responseData(error);
  return data?.success === false && typeof data.code === 'string'
    ? readTestDiagnostics(data)
    : undefined;
};
