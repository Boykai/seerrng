import type SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import type {
  SuwayomiAuthDetection,
  SuwayomiSource,
} from '@server/api/suwayomi/types';
import type {
  SuwayomiConnectionTestErrorCode,
  SuwayomiConnectionTestFailure,
  SuwayomiConnectionTestResponse,
  SuwayomiConnectionTestWarning,
  SuwayomiConnectionTestWarningCode,
} from '@server/interfaces/api/suwayomiInterfaces';
import type { SuwayomiSettingsAuthMode } from '@server/lib/settings';
import { createSuwayomiClient } from '@server/lib/suwayomi/clientFactory';
import logger from '@server/logger';
import type { SuwayomiConnectionTestInput } from '@server/utils/suwayomiSettings';

/** One deadline for the whole test, on top of the client's call timeouts. */
export const SUWAYOMI_CONNECTION_TEST_DEADLINE_MS = 40_000;

export const SUWAYOMI_CONNECTION_TEST_MESSAGES: Record<
  SuwayomiConnectionTestErrorCode,
  string
> = {
  SUWAYOMI_UNREACHABLE: 'Suwayomi could not be reached.',
  SUWAYOMI_TIMEOUT: 'The Suwayomi connection test did not finish in time.',
  SUWAYOMI_NOT_SUWAYOMI: 'The address did not answer like a Suwayomi server.',
  SUWAYOMI_AUTH_FAILED: 'Suwayomi rejected the username or password.',
  SUWAYOMI_CREDENTIALS_REQUIRED:
    'Suwayomi requires a login. Enter its username and password.',
  SUWAYOMI_SIMPLE_LOGIN_UNSUPPORTED:
    'Suwayomi uses simple login, which SeerrNG does not support. Switch Suwayomi to UI login.',
  SUWAYOMI_UNSUPPORTED_SERVER:
    'This Suwayomi server lacks features SeerrNG needs. Update Suwayomi to v2.3.2223 or later.',
  SUWAYOMI_NO_SOURCES:
    'Suwayomi has no sources installed besides the local source.',
  SUWAYOMI_CBZ_REQUIRED:
    'Suwayomi does not save downloads as CBZ files. Enable CBZ downloads in Suwayomi or turn off Require CBZ.',
  SUWAYOMI_UPSTREAM_ERROR: 'The server reported an error during the test.',
};

const WARNING_ORDER: readonly SuwayomiConnectionTestWarningCode[] = [
  'AUTH_DISABLED',
  'BASIC_AUTH_IN_USE',
  'EMPTY_CREDENTIALS',
  'CBZ_DISABLED',
  'QUEUE_ERRORS',
  'BELOW_PINNED_REVISION',
  'UNKNOWN_VERSION',
  'INTROSPECTION_UNAVAILABLE',
  'PER_USER_SCHEMA',
  'SOURCE_UPDATE_AVAILABLE',
  'SOURCE_OBSOLETE',
  'SOURCE_MISSING',
];

type Stage = 'detection' | 'checks';

class ConnectionTestVerdict extends Error {
  constructor(readonly code: SuwayomiConnectionTestErrorCode) {
    super(code);
  }
}

class DeadlineExpired extends Error {}

const fail = (code: SuwayomiConnectionTestErrorCode): never => {
  throw new ConnectionTestVerdict(code);
};

const classify = (
  error: SuwayomiError,
  stage: Stage
): SuwayomiConnectionTestErrorCode => {
  switch (error.code) {
    case 'UNREACHABLE':
    case 'REQUEST_REFUSED':
      return 'SUWAYOMI_UNREACHABLE';
    case 'TIMEOUT':
    case 'ABORTED':
      return 'SUWAYOMI_TIMEOUT';
    case 'AUTH_FAILED':
    case 'AUTH_REQUIRED':
    case 'AUTH_MODE_MISMATCH':
      return 'SUWAYOMI_AUTH_FAILED';
    case 'UNSUPPORTED_SERVER':
      return 'SUWAYOMI_UNSUPPORTED_SERVER';
    case 'HTTP_ERROR':
    case 'NOT_FOUND':
    case 'BAD_RESPONSE':
    case 'RESPONSE_TOO_LARGE':
      return stage === 'detection'
        ? 'SUWAYOMI_NOT_SUWAYOMI'
        : 'SUWAYOMI_UPSTREAM_ERROR';
    default:
      return 'SUWAYOMI_UPSTREAM_ERROR';
  }
};

const authWarnings = (
  detection: SuwayomiAuthDetection
): SuwayomiConnectionTestWarning[] =>
  detection.warnings.flatMap((code) =>
    // The first client's mode is only a guess, so a mismatch means nothing.
    code === 'MODE_MISMATCH' ? [] : [{ code }]
  );

const sourceWarnings = (
  sources: SuwayomiSource[],
  allowlist: string[]
): SuwayomiConnectionTestWarning[] => {
  const byId = new Map(sources.map((source) => [source.id, source]));
  const warning = (
    code: SuwayomiConnectionTestWarningCode,
    sourceIds: string[]
  ): SuwayomiConnectionTestWarning[] =>
    sourceIds.length > 0 ? [{ code, sourceIds }] : [];
  return [
    ...warning(
      'SOURCE_UPDATE_AVAILABLE',
      allowlist.filter((id) => byId.get(id)?.hasUpdate)
    ),
    ...warning(
      'SOURCE_OBSOLETE',
      allowlist.filter((id) => byId.get(id)?.isObsolete)
    ),
    ...warning(
      'SOURCE_MISSING',
      allowlist.filter((id) => !byId.has(id))
    ),
  ];
};

const ordered = (
  warnings: SuwayomiConnectionTestWarning[]
): SuwayomiConnectionTestWarning[] =>
  [...warnings].sort(
    (a, b) => WARNING_ORDER.indexOf(a.code) - WARNING_ORDER.indexOf(b.code)
  );

/**
 * Checks a Suwayomi server before its settings are saved: detects the
 * authentication mode, verifies the credentials and the server's
 * capabilities, and lists its sources. It only sends read-only queries and
 * the login and token refresh mutations.
 *
 * Failures carry a stable code and a fixed message; Suwayomi's own error text
 * never reaches the result or the log.
 */
export const runSuwayomiConnectionTest = async (
  input: SuwayomiConnectionTestInput,
  {
    deadlineMs = SUWAYOMI_CONNECTION_TEST_DEADLINE_MS,
    signal: callerSignal,
  }: { deadlineMs?: number; signal?: AbortSignal } = {}
): Promise<SuwayomiConnectionTestResponse> => {
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => controller.abort();
  callerSignal?.addEventListener('abort', cancel, { once: true });
  if (callerSignal?.aborted) {
    cancel();
  }
  let expired = false;
  let expire: () => void = () => undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new DeadlineExpired());
  });
  // Marks the rejection as handled while no step is waiting on it.
  deadline.catch(() => undefined);
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    expire();
  }, deadlineMs);
  const step = <T>(promise: Promise<T>): Promise<T> =>
    Promise.race([promise, deadline]);

  const hasCredentials = input.username !== '' || input.password !== '';
  const clientFor = (authMode: SuwayomiSettingsAuthMode): SuwayomiAPI =>
    createSuwayomiClient(
      { ...input, authMode },
      { warnInsecureAuthMode: false }
    );
  const state: Omit<SuwayomiConnectionTestFailure, 'code' | 'message'> = {
    success: false,
    warnings: [],
  };
  let stage: Stage = 'detection';

  try {
    // UI login is the recommended mode, so it is tried first when there are
    // credentials; detection reports the mode the server actually uses.
    let client = clientFor(hasCredentials ? 'UI_LOGIN' : 'NONE');
    let detection = await step(client.detectAuthMode({ signal }));
    state.authMode = detection.mode;
    if (
      detection.mode === 'BASIC_AUTH' &&
      hasCredentials &&
      !detection.authenticated
    ) {
      client = clientFor('BASIC_AUTH');
      detection = await step(client.detectAuthMode({ signal }));
      state.authMode = detection.mode;
    }
    state.warnings.push(...authWarnings(detection));

    let authMode: SuwayomiSettingsAuthMode;
    switch (detection.mode) {
      case 'SIMPLE_LOGIN':
        return fail('SUWAYOMI_SIMPLE_LOGIN_UNSUPPORTED');
      case 'LOGIN_REQUIRED':
        return fail('SUWAYOMI_CREDENTIALS_REQUIRED');
      case 'NONE':
        authMode = 'NONE';
        if (client.authMode !== 'NONE') {
          client = clientFor('NONE');
        }
        break;
      default:
        if (!detection.authenticated) {
          return fail(
            hasCredentials
              ? 'SUWAYOMI_AUTH_FAILED'
              : 'SUWAYOMI_CREDENTIALS_REQUIRED'
          );
        }
        authMode = detection.mode;
    }

    stage = 'checks';
    const capabilities = await step(client.getCapabilities({ signal }));
    state.version = capabilities.version;
    state.warnings.push(...capabilities.warnings.map((code) => ({ code })));
    if (!capabilities.supported) {
      state.missingFields = capabilities.missingFields;
      return fail('SUWAYOMI_UNSUPPORTED_SERVER');
    }

    const health = await step(client.getHealth({ signal }));
    state.version ??= health.version;
    if (!input.requireCbz && health.settings.downloadAsCbz === false) {
      state.warnings.push({ code: 'CBZ_DISABLED' });
    }
    if (health.queueErrors > 0) {
      state.warnings.push({ code: 'QUEUE_ERRORS', count: health.queueErrors });
    }
    if (health.sourceCount === 0) {
      return fail('SUWAYOMI_NO_SOURCES');
    }
    if (input.requireCbz && health.settings.downloadAsCbz !== true) {
      return fail('SUWAYOMI_CBZ_REQUIRED');
    }

    const sources = await step(client.getSources({ signal }));
    state.warnings.push(...sourceWarnings(sources, input.sourceAllowlist));

    return {
      success: true,
      authMode,
      version: state.version,
      capabilities: {
        revision: capabilities.revision,
        buildType: capabilities.buildType,
        supported: capabilities.supported,
        missingFields: capabilities.missingFields,
      },
      health: {
        downloaderState: health.downloaderState,
        queueLength: health.queueLength,
        queueErrors: health.queueErrors,
        sourceCount: health.sourceCount,
        downloadAsCbz: health.settings.downloadAsCbz,
      },
      warnings: ordered(state.warnings),
      sources: sources.map((source) => ({
        id: source.id,
        name: source.name,
        displayName: source.displayName,
        lang: source.lang,
        contentWarning: source.contentWarning,
        hasUpdate: source.hasUpdate,
        isObsolete: source.isObsolete,
      })),
    };
  } catch (error) {
    let code: SuwayomiConnectionTestErrorCode;
    if (expired) {
      code = 'SUWAYOMI_TIMEOUT';
    } else if (error instanceof ConnectionTestVerdict) {
      code = error.code;
    } else if (
      error instanceof SuwayomiError &&
      error.operation !== 'configure'
    ) {
      code = classify(error, stage);
    } else {
      // Settings are validated before a test starts, so this is a bug.
      throw error;
    }
    logger.warn('Suwayomi connection test failed', {
      label: 'Suwayomi',
      code,
      operation: error instanceof SuwayomiError ? error.operation : undefined,
    });
    return {
      ...state,
      code,
      message: SUWAYOMI_CONNECTION_TEST_MESSAGES[code],
      warnings: ordered(state.warnings),
    };
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', cancel);
  }
};
