import ExternalAPI from '@server/api/externalapi';
import {
  SuwayomiTokenManager,
  basicAuthorization,
  type SuwayomiTokens,
} from '@server/api/suwayomi/auth';
import { evaluateCapabilities } from '@server/api/suwayomi/capabilities';
import {
  SuwayomiError,
  interpretGraphQLResponse,
  isRecord,
  reportSuwayomiError,
  toSuwayomiError,
  type GraphQLResult,
} from '@server/api/suwayomi/errors';
import {
  badResponse,
  mapHealth,
  mapSource,
  nodes,
  record,
} from '@server/api/suwayomi/mappers';
import {
  SUWAYOMI_OPERATIONS,
  type SuwayomiAuthLevel,
  type SuwayomiOperationName,
} from '@server/api/suwayomi/operations';
import type {
  SuwayomiAPIOptions,
  SuwayomiAuthDetection,
  SuwayomiAuthMode,
  SuwayomiAuthWarning,
  SuwayomiCallClass,
  SuwayomiCallOptions,
  SuwayomiCapabilities,
  SuwayomiDetectedAuthMode,
  SuwayomiHealth,
  SuwayomiSource,
  SuwayomiTimeouts,
} from '@server/api/suwayomi/types';
import logger from '@server/logger';
import type { AxiosResponse } from 'axios';

const GRAPHQL_PATH = 'api/graphql';
const BEARER = 'Bearer ';
const LOCAL_SOURCE_ID = '0';
export const DEFAULT_SUWAYOMI_TIMEOUTS: Readonly<SuwayomiTimeouts> = {
  query: 15_000,
  mutation: 15_000,
  // Suwayomi waits up to 30 s for the downloader before answering.
  queue: 45_000,
  source: 150_000,
  bytes: 45_000,
};
const TOKEN_PATTERN = /^[\w-]+\.[\w-]+\.[\w-]*$/;
const SUPPORTED_MODES = new Set<SuwayomiDetectedAuthMode>([
  'NONE',
  'BASIC_AUTH',
  'UI_LOGIN',
]);
const warnedModes = new Set<string>();

interface PostOptions extends SuwayomiCallOptions {
  allowPartial?: boolean;
  /** How to read a 401; detection probes interpret it as unconfigured. */
  interpretAs?: SuwayomiAuthMode;
}

const invalid = (operation: string): never => {
  throw new SuwayomiError('INVALID_ARGUMENT', operation);
};

const failureCode = (error: unknown) =>
  error instanceof SuwayomiError ? error.code : undefined;

const configuredNumber = (
  value: number | undefined,
  fallback: number,
  min: number
): number => {
  if (value === undefined) {
    return fallback;
  }
  return Number.isSafeInteger(value) && value >= min
    ? value
    : invalid('configure');
};

const jwt = (value: unknown, operation: string): string =>
  typeof value === 'string' &&
  value.length <= 8_192 &&
  TOKEN_PATTERN.test(value)
    ? value
    : badResponse(operation);

const parseBaseUrl = (value: string): string => {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    return invalid('configure');
  }
  url.search = '';
  url.hash = '';
  return url.href;
};

/**
 * Client for one Suwayomi-Server instance over its GraphQL API. Every failure surfaces as a {@link SuwayomiError} with a
 * stable code; upstream error text is classified and then discarded.
 */
class SuwayomiAPI extends ExternalAPI {
  readonly authMode: SuwayomiAuthMode;
  readonly #origin: string;
  readonly #credentials?: { username: string; password: string };
  readonly #basicAuthorization?: string;
  readonly #tokens?: SuwayomiTokenManager;
  readonly #timeouts: SuwayomiTimeouts;

  constructor(options: SuwayomiAPIOptions) {
    const baseUrl = parseBaseUrl(options?.url);
    // An administrator configures this URL, and Suwayomi normally runs on a
    // private network next to SeerrNG (the same policy as Kapowarr and Mylar).
    super(baseUrl, {}, { allowPrivateAddresses: true });

    const auth = options.auth;
    if (
      !isRecord(auth) ||
      !['UI_LOGIN', 'BASIC_AUTH', 'NONE'].includes(auth.mode)
    ) {
      throw new SuwayomiError('AUTH_MODE_UNSUPPORTED', 'configure');
    }
    this.authMode = auth.mode;
    if (auth.mode !== 'NONE') {
      const { username, password } = auth;
      if (typeof username !== 'string' || typeof password !== 'string') {
        invalid('configure');
      }
      this.#credentials = { username, password };
      if (auth.mode === 'BASIC_AUTH') {
        this.#basicAuthorization = basicAuthorization(username, password);
      } else {
        this.#tokens = new SuwayomiTokenManager({
          login: () => this.login(),
          refresh: (refreshToken) => this.refresh(refreshToken),
        });
      }
    }

    const timeouts = options.timeouts ?? {};
    this.#timeouts = { ...DEFAULT_SUWAYOMI_TIMEOUTS };
    for (const key of Object.keys(this.#timeouts) as SuwayomiCallClass[]) {
      this.#timeouts[key] = configuredNumber(
        timeouts[key],
        DEFAULT_SUWAYOMI_TIMEOUTS[key],
        1
      );
    }
    this.#origin = new URL(baseUrl).origin;
    this.warnAboutMode(auth.mode);
  }

  /** Identifies the server's auth mode and checks the configured credentials. */
  async detectAuthMode(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiAuthDetection> {
    const { signal } = options;
    const configured = this.authMode;
    const warnings = new Set<SuwayomiAuthWarning>();
    if (
      this.#credentials &&
      (!this.#credentials.username || !this.#credentials.password)
    ) {
      warnings.add('EMPTY_CREDENTIALS');
    }
    const detected = (
      mode: SuwayomiDetectedAuthMode,
      authenticated: boolean
    ): SuwayomiAuthDetection => {
      if (mode !== configured) warnings.add('MODE_MISMATCH');
      if (mode === 'NONE') warnings.add('AUTH_DISABLED');
      if (mode === 'BASIC_AUTH') warnings.add('BASIC_AUTH_IN_USE');
      this.warnAboutMode(mode);
      return {
        mode,
        supported: SUPPORTED_MODES.has(mode),
        authenticated,
        matchesConfigured: mode === configured,
        warnings: [...warnings],
      };
    };

    try {
      // 1. Without credentials, a Basic challenge identifies BASIC_AUTH.
      try {
        await this.postGraphQL('Probe', undefined, undefined, {
          signal,
          interpretAs: 'NONE',
        });
      } catch (error) {
        if (failureCode(error) === 'AUTH_MODE_MISMATCH') {
          if (!this.#basicAuthorization) {
            return detected('BASIC_AUTH', false);
          }
          await this.postGraphQL(
            'AuthTest',
            undefined,
            this.#basicAuthorization,
            {
              signal,
              interpretAs: 'BASIC_AUTH',
            }
          );
          return detected('BASIC_AUTH', true);
        }
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
      }

      // 2. A protected query that succeeds anonymously means NONE.
      try {
        await this.postGraphQL('AuthTest', undefined, undefined, {
          signal,
          interpretAs: 'NONE',
        });
        return detected('NONE', configured !== 'UI_LOGIN');
      } catch (error) {
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
      }

      // 3. SIMPLE_LOGIN issues tokens from `login` but ignores them.
      if (!this.#credentials) {
        return detected('LOGIN_REQUIRED', false);
      }
      const tokens = await this.login(signal);
      try {
        await this.postGraphQL(
          'AuthTest',
          undefined,
          `${BEARER}${tokens.accessToken}`,
          {
            signal,
            interpretAs: 'UI_LOGIN',
          }
        );
      } catch (error) {
        if (failureCode(error) !== 'AUTH_REQUIRED') throw error;
        return detected('SIMPLE_LOGIN', false);
      }
      this.#tokens?.seed(tokens);
      return detected('UI_LOGIN', configured === 'UI_LOGIN');
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, 'AuthDetection'));
    }
  }

  async getCapabilities(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiCapabilities> {
    try {
      return await this.run('Capabilities', undefined, options, (data) => {
        const schema = record(data.__schema, 'Capabilities');
        return evaluateCapabilities({
          about: data.aboutServer,
          introspection: {
            queryType: schema.queryType,
            mutationType: schema.mutationType,
            mangaType: data.mangaType,
            chapterType: data.chapterType,
          },
        });
      });
    } catch (error) {
      const code = failureCode(error);
      if (code !== 'UPSTREAM_ERROR' && code !== 'BAD_RESPONSE') throw error;
      return this.run('Probe', undefined, options, (data) =>
        evaluateCapabilities({ about: data.aboutServer })
      );
    }
  }

  async getHealth(options: SuwayomiCallOptions = {}): Promise<SuwayomiHealth> {
    return this.run('Health', undefined, options, (data) =>
      mapHealth(data, 'Health')
    );
  }

  /** Installed sources, without the built-in local source. */
  async getSources(
    options: SuwayomiCallOptions = {}
  ): Promise<SuwayomiSource[]> {
    return this.run('Sources', undefined, options, (data) =>
      nodes(data.sources, 'Sources')
        .map((node) => mapSource(node, 'Sources'))
        .filter((source) => source.id !== LOCAL_SOURCE_ID)
    );
  }

  private warnAboutMode(mode: string): void {
    const key = `${mode} ${this.#origin}`;
    if ((mode !== 'NONE' && mode !== 'BASIC_AUTH') || warnedModes.has(key)) {
      return;
    }
    warnedModes.add(key);
    logger.warn(
      mode === 'NONE'
        ? 'Suwayomi authentication is disabled: anyone who can reach the server controls it. Enable UI login in Suwayomi.'
        : 'Suwayomi uses Basic authentication, which sends the credentials with every request. Prefer UI login.',
      { label: 'Suwayomi' }
    );
  }

  private async authorization(
    level: SuwayomiAuthLevel
  ): Promise<string | undefined> {
    if (level === 'none') return undefined;
    if (this.#basicAuthorization) return this.#basicAuthorization;
    if (level === 'public' || !this.#tokens) return undefined;
    return `${BEARER}${await this.#tokens.getAccessToken()}`;
  }

  private async login(signal?: AbortSignal): Promise<SuwayomiTokens> {
    const { username, password } = this.#credentials ?? invalid('Login');
    const { data } = await this.postGraphQL(
      'Login',
      { username, password },
      undefined,
      {
        signal,
        interpretAs: 'UI_LOGIN',
      }
    );
    const payload = record(data.login, 'Login');
    return {
      accessToken: jwt(payload.accessToken, 'Login'),
      refreshToken: jwt(payload.refreshToken, 'Login'),
    };
  }

  private async refresh(refreshToken: string): Promise<string> {
    const { data } = await this.postGraphQL(
      'Refresh',
      { refreshToken },
      undefined,
      {
        interpretAs: 'UI_LOGIN',
      }
    );
    return jwt(record(data.refreshToken, 'Refresh').accessToken, 'Refresh');
  }

  /** One GraphQL round trip with an explicit Authorization header. */
  private async postGraphQL(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    authorization: string | undefined,
    options: PostOptions = {}
  ): Promise<GraphQLResult> {
    const operation = SUWAYOMI_OPERATIONS[name];
    let response: AxiosResponse<unknown>;
    try {
      response = await this.request<unknown>(
        'POST',
        GRAPHQL_PATH,
        {
          operationName: name,
          query: operation.document,
          variables: variables ?? {},
        },
        {
          headers: authorization ? { Authorization: authorization } : {},
          signal: options.signal,
          timeout: this.#timeouts[operation.callClass],
          validateStatus: () => true,
        }
      );
    } catch (error) {
      throw toSuwayomiError(error, name);
    }
    return interpretGraphQLResponse(
      name,
      response,
      options.interpretAs ?? this.authMode,
      options.allowPartial
    );
  }

  /** Sends with configured auth and renews an access token once on rejection. */
  private async execute(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    options: PostOptions
  ): Promise<GraphQLResult> {
    const { auth } = SUWAYOMI_OPERATIONS[name];
    try {
      const authorization = await this.authorization(auth);
      try {
        return await this.postGraphQL(name, variables, authorization, options);
      } catch (error) {
        if (
          !this.#tokens ||
          auth !== 'user' ||
          failureCode(error) !== 'AUTH_REQUIRED'
        ) {
          throw error;
        }
        const token = await this.#tokens.renew(
          authorization?.slice(BEARER.length)
        );
        return await this.postGraphQL(
          name,
          variables,
          `${BEARER}${token}`,
          options
        );
      }
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, name));
    }
  }

  private async run<T>(
    name: SuwayomiOperationName,
    variables: Record<string, unknown> | undefined,
    options: SuwayomiCallOptions,
    map: (data: Record<string, unknown>, result: GraphQLResult) => T,
    allowPartial = false
  ): Promise<T> {
    const result = await this.execute(name, variables, {
      signal: options.signal,
      allowPartial,
    });
    try {
      return map(result.data, result);
    } catch (error) {
      throw reportSuwayomiError(toSuwayomiError(error, name));
    }
  }
}

export default SuwayomiAPI;
