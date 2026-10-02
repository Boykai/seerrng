import { AnilistRateLimitedError } from '@server/api/anilist/failures';

// AniList limits requests per client IP, so every AniList call in this process
// (anime, linked accounts, OAuth and manga) shares this one budget.
export const ANILIST_MAX_REQUESTS_PER_WINDOW = 30;
export const ANILIST_RATE_WINDOW_MS = 60_000;
export const ANILIST_MIN_REQUEST_SPACING_MS = 1_000;
export const ANILIST_DEFAULT_RETRY_AFTER_SECONDS = 60;
export const ANILIST_MAX_RETRY_AFTER_SECONDS = 3600;
export const ANILIST_DEFAULT_MAX_WAIT_MS = 10_000;

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clampRetryAfterSeconds = (seconds: number): number =>
  Math.min(ANILIST_MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));

const HTTP_DATE_PREFIX = /^[A-Za-z]{3}/;

/**
 * Accept delay-seconds or an HTTP-date. Anything else falls back to the
 * default cooldown so a malformed header never disables backoff.
 */
export const parseAnilistRetryAfterSeconds = (
  value: unknown,
  now = Date.now()
): number => {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0
      ? clampRetryAfterSeconds(raw)
      : ANILIST_DEFAULT_RETRY_AFTER_SECONDS;
  }
  if (typeof raw !== 'string') {
    return ANILIST_DEFAULT_RETRY_AFTER_SECONDS;
  }
  const trimmed = raw.trim();
  if (/^\d{1,10}$/.test(trimmed)) {
    return clampRetryAfterSeconds(Number(trimmed));
  }
  if (HTTP_DATE_PREFIX.test(trimmed)) {
    const date = Date.parse(trimmed);
    if (Number.isFinite(date)) {
      return clampRetryAfterSeconds((date - now) / 1000);
    }
  }
  return ANILIST_DEFAULT_RETRY_AFTER_SECONDS;
};

class AnilistRateLimiter {
  private starts: number[] = [];
  private cooldownUntil = 0;
  private now: () => number = Date.now;
  private sleep: Sleep = defaultSleep;

  configure(options: { now?: () => number; sleep?: Sleep } = {}): void {
    this.starts = [];
    this.cooldownUntil = 0;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /**
   * Reserve the next request start. Waits up to `maxWaitMs`; a longer wait
   * fails fast with the remaining time so callers can surface a 429.
   */
  async acquire(maxWaitMs = ANILIST_DEFAULT_MAX_WAIT_MS): Promise<void> {
    const deadline = this.now() + Math.max(0, maxWaitMs);
    for (;;) {
      const now = this.now();
      const slot = this.nextSlot(now);
      if (slot > deadline) {
        throw new AnilistRateLimitedError(
          Math.max(1, Math.ceil((slot - now) / 1000))
        );
      }
      this.starts.push(slot);
      if (slot <= now) {
        return;
      }
      const cooldownAtReservation = this.cooldownUntil;
      await this.sleep(slot - now);
      if (
        this.cooldownUntil > cooldownAtReservation &&
        this.cooldownUntil > this.now()
      ) {
        // A 429 arrived while this request waited; give the slot back and
        // plan again against the new cooldown.
        const index = this.starts.indexOf(slot);
        if (index !== -1) {
          this.starts.splice(index, 1);
        }
        continue;
      }
      return;
    }
  }

  noteRateLimited(retryAfterSeconds: number): void {
    const seconds = clampRetryAfterSeconds(
      Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : ANILIST_DEFAULT_RETRY_AFTER_SECONDS
    );
    this.cooldownUntil = Math.max(
      this.cooldownUntil,
      this.now() + seconds * 1000
    );
  }

  private nextSlot(now: number): number {
    while (
      this.starts.length > 0 &&
      this.starts[0] <= now - ANILIST_RATE_WINDOW_MS
    ) {
      this.starts.shift();
    }
    let slot = Math.max(now, this.cooldownUntil);
    const last = this.starts[this.starts.length - 1];
    if (last !== undefined) {
      slot = Math.max(slot, last + ANILIST_MIN_REQUEST_SPACING_MS);
    }
    if (this.starts.length >= ANILIST_MAX_REQUESTS_PER_WINDOW) {
      slot = Math.max(
        slot,
        this.starts[this.starts.length - ANILIST_MAX_REQUESTS_PER_WINDOW] +
          ANILIST_RATE_WINDOW_MS
      );
    }
    return slot;
  }
}

export const anilistRateLimiter = new AnilistRateLimiter();

/** Test helper: clear the shared budget and optionally inject a clock. */
export const resetAnilistRateLimiterForTests = (
  options: { now?: () => number; sleep?: Sleep } = {}
): void => {
  anilistRateLimiter.configure(options);
};
