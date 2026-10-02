import { SuwayomiError } from '@server/api/suwayomi/errors';

export interface SuwayomiTokens {
  accessToken: string;
  refreshToken: string;
}

export interface SuwayomiTokenHandlers {
  login(): Promise<SuwayomiTokens>;
  refresh(refreshToken: string): Promise<string>;
}

/** Renew this long before the access token expires. */
export const TOKEN_REFRESH_MARGIN_MS = 60_000;

const TRANSPORT_FAILURES = new Set([
  'UNREACHABLE',
  'TIMEOUT',
  'ABORTED',
  'REQUEST_REFUSED',
]);

/** Reads `exp` (milliseconds) from a JWT payload without verifying it. */
export const decodeJwtExpiry = (token: string): number | undefined => {
  const payload = token.split('.')[1];
  if (!payload || payload.length > 8_192) {
    return undefined;
  }
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    );
    const exp =
      typeof claims === 'object' && claims !== null
        ? (claims as { exp?: unknown }).exp
        : undefined;
    return typeof exp === 'number' && Number.isFinite(exp)
      ? exp * 1_000
      : undefined;
  } catch {
    return undefined;
  }
};

export const basicAuthorization = (username: string, password: string) =>
  `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;

/**
 * Holds UI_LOGIN tokens in memory only. Renewal is single-flight: concurrent
 * callers share one refresh or login, and a caller holding a token that has
 * already been replaced gets the new token without another renewal.
 */
export class SuwayomiTokenManager {
  #accessToken?: string;
  #accessRenewAt?: number;
  #refreshToken?: string;
  #refreshExpiry?: number;
  #pending?: Promise<string>;

  constructor(
    private readonly handlers: SuwayomiTokenHandlers,
    private readonly now: () => number = Date.now
  ) {}

  seed(tokens: SuwayomiTokens): void {
    this.setAccessToken(tokens.accessToken);
    this.#refreshToken = tokens.refreshToken;
    this.#refreshExpiry = decodeJwtExpiry(tokens.refreshToken);
  }

  clear(): void {
    this.#accessToken = undefined;
    this.#accessRenewAt = undefined;
    this.#refreshToken = undefined;
    this.#refreshExpiry = undefined;
  }

  async getAccessToken(): Promise<string> {
    if (this.#accessToken && this.isFresh()) {
      return this.#accessToken;
    }
    return this.renew(this.#accessToken);
  }

  /** Replaces `staleToken` unless another caller already has. */
  renew(staleToken: string | undefined): Promise<string> {
    if (
      this.#accessToken &&
      this.#accessToken !== staleToken &&
      this.isFresh()
    ) {
      return Promise.resolve(this.#accessToken);
    }
    this.#pending ??= this.obtain().finally(() => {
      this.#pending = undefined;
    });
    return this.#pending;
  }

  private isFresh(): boolean {
    return (
      this.#accessRenewAt === undefined || this.now() < this.#accessRenewAt
    );
  }

  private setAccessToken(token: string): void {
    const expiry = decodeJwtExpiry(token);
    const now = this.now();
    this.#accessToken = token;
    // Without a usable expiry (or with clock skew) rely on reactive renewal.
    this.#accessRenewAt =
      expiry === undefined || expiry <= now
        ? undefined
        : expiry - Math.min(TOKEN_REFRESH_MARGIN_MS, (expiry - now) / 2);
  }

  private async obtain(): Promise<string> {
    const refreshToken = this.#refreshToken;
    if (
      refreshToken &&
      (this.#refreshExpiry === undefined || this.#refreshExpiry > this.now())
    ) {
      try {
        const accessToken = await this.handlers.refresh(refreshToken);
        this.setAccessToken(accessToken);
        return accessToken;
      } catch (error) {
        // A server that cannot be reached will not accept a login either.
        if (
          error instanceof SuwayomiError &&
          TRANSPORT_FAILURES.has(error.code)
        ) {
          throw error;
        }
      }
    }

    this.clear();
    const tokens = await this.handlers.login();
    this.seed(tokens);
    return tokens.accessToken;
  }
}
