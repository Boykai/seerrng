import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import {
  ANILIST_DEFAULT_RETRY_AFTER_SECONDS,
  ANILIST_MAX_REQUESTS_PER_WINDOW,
  anilistRateLimiter,
  parseAnilistRetryAfterSeconds,
  resetAnilistRateLimiterForTests,
} from '@server/api/anilist/rateLimiter';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

let now = 0;
let sleeps: number[] = [];
let onSleep: (() => void) | undefined;

const useFakeClock = () => {
  now = 1_000_000;
  sleeps = [];
  onSleep = undefined;
  resetAnilistRateLimiterForTests({
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      onSleep?.();
      now += ms;
    },
  });
};

const assertRateLimited = (retryAfterSeconds: number) => (error: unknown) => {
  assert.ok(error instanceof AnilistRateLimitedError);
  assert.equal(error.retryAfterSeconds, retryAfterSeconds);
  return true;
};

beforeEach(useFakeClock);

afterEach(() => {
  resetAnilistRateLimiterForTests();
});

describe('AniList rate limiter', () => {
  it('starts the first request at once and spaces the rest a second apart', async () => {
    await anilistRateLimiter.acquire();
    await anilistRateLimiter.acquire();
    await anilistRateLimiter.acquire();

    assert.deepEqual(sleeps, [1_000, 1_000]);
  });

  it('allows no more than the window budget per minute', async () => {
    const start = now;
    for (let i = 0; i < ANILIST_MAX_REQUESTS_PER_WINDOW; i += 1) {
      await anilistRateLimiter.acquire();
    }
    assert.equal(now - start, (ANILIST_MAX_REQUESTS_PER_WINDOW - 1) * 1_000);

    await anilistRateLimiter.acquire(60_000);

    assert.equal(now - start, 60_000);
  });

  it('fails fast with the remaining wait when the budget is spent', async () => {
    for (let i = 0; i < ANILIST_MAX_REQUESTS_PER_WINDOW; i += 1) {
      await anilistRateLimiter.acquire();
    }
    const sleepsBefore = sleeps.length;

    await assert.rejects(anilistRateLimiter.acquire(), assertRateLimited(31));
    assert.equal(sleeps.length, sleepsBefore);
  });

  it('reserves nothing for a request it refuses', async () => {
    anilistRateLimiter.noteRateLimited(120);

    await assert.rejects(
      anilistRateLimiter.acquire(10_000),
      assertRateLimited(120)
    );

    now += 120_000;
    await anilistRateLimiter.acquire();
    assert.deepEqual(sleeps, []);
  });

  it('waits out a Retry-After cooldown when the caller allows it', async () => {
    anilistRateLimiter.noteRateLimited(5);

    await anilistRateLimiter.acquire();

    assert.deepEqual(sleeps, [5_000]);
  });

  it('never shortens an active cooldown', async () => {
    anilistRateLimiter.noteRateLimited(120);
    anilistRateLimiter.noteRateLimited(5);

    await assert.rejects(anilistRateLimiter.acquire(), assertRateLimited(120));
    await anilistRateLimiter.acquire(120_000);
    assert.deepEqual(sleeps, [120_000]);
  });

  it('plans again when a 429 arrives while a request waits', async () => {
    await anilistRateLimiter.acquire();
    onSleep = () => {
      onSleep = undefined;
      anilistRateLimiter.noteRateLimited(30);
    };

    await anilistRateLimiter.acquire(60_000);

    assert.deepEqual(sleeps, [1_000, 29_000]);
  });

  it('releases a slot abandoned for a new cooldown', async () => {
    for (let i = 0; i < ANILIST_MAX_REQUESTS_PER_WINDOW - 2; i += 1) {
      await anilistRateLimiter.acquire();
    }
    onSleep = () => {
      onSleep = undefined;
      anilistRateLimiter.noteRateLimited(30);
    };
    await anilistRateLimiter.acquire(60_000);
    const replannedStart = now;

    // With the abandoned slot still counted, the window would be full and
    // this start would slip to a minute after the first one.
    await anilistRateLimiter.acquire();

    assert.equal(now - replannedStart, 1_000);
  });

  it('fails fast when a 429 during the wait pushes past the deadline', async () => {
    await anilistRateLimiter.acquire();
    onSleep = () => {
      onSleep = undefined;
      anilistRateLimiter.noteRateLimited(120);
    };

    await assert.rejects(
      anilistRateLimiter.acquire(10_000),
      assertRateLimited(119)
    );

    now += 119_000;
    await anilistRateLimiter.acquire();
    assert.deepEqual(sleeps, [1_000]);
  });
});

describe('parseAnilistRetryAfterSeconds', () => {
  it('reads delay seconds and clamps them to one hour', () => {
    assert.equal(parseAnilistRetryAfterSeconds('120'), 120);
    assert.equal(parseAnilistRetryAfterSeconds(' 7 '), 7);
    assert.equal(parseAnilistRetryAfterSeconds(['45']), 45);
    assert.equal(parseAnilistRetryAfterSeconds(30), 30);
    assert.equal(parseAnilistRetryAfterSeconds('0'), 1);
    assert.equal(parseAnilistRetryAfterSeconds('999999'), 3600);
  });

  it('reads an HTTP date relative to the current time', () => {
    const current = Date.parse('Wed, 21 Oct 2026 07:28:00 GMT');

    assert.equal(
      parseAnilistRetryAfterSeconds('Wed, 21 Oct 2026 07:30:00 GMT', current),
      120
    );
    assert.equal(
      parseAnilistRetryAfterSeconds('Wed, 21 Oct 2026 07:00:00 GMT', current),
      1
    );
  });

  it('falls back to the default cooldown for missing or malformed values', () => {
    for (const value of [
      undefined,
      null,
      '',
      'soon',
      '1.5',
      '-5',
      -5,
      Number.NaN,
      {},
    ]) {
      assert.equal(
        parseAnilistRetryAfterSeconds(value),
        ANILIST_DEFAULT_RETRY_AFTER_SECONDS,
        `value ${String(value)}`
      );
    }
  });
});
