import { describe, expect, it } from 'vitest';
import { getDiscoveryFeedFailure } from './discoveryFeedError';

describe('discovery feed failure recovery', () => {
  it('honors and bounds a provider Retry-After value', () => {
    expect(
      getDiscoveryFeedFailure(
        {
          response: {
            status: 429,
            headers: { 'Retry-After': '120' },
          },
        },
        1_000
      )
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 120 });
    expect(
      getDiscoveryFeedFailure({
        response: { status: 429, headers: { 'retry-after': '99999' } },
      })
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 3600 });
  });

  it('uses a bounded fallback for a missing or malformed retry window', () => {
    expect(
      getDiscoveryFeedFailure({ response: { status: 429, headers: {} } })
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 60 });
    expect(
      getDiscoveryFeedFailure(
        { response: { status: 429, headers: { 'retry-after': 'soon' } } },
        0
      )
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 60 });
  });

  it('parses an HTTP-date Retry-After value', () => {
    expect(
      getDiscoveryFeedFailure(
        {
          response: {
            status: 429,
            headers: { 'retry-after': 'Thu, 01 Jan 1970 00:02:00 GMT' },
          },
        },
        1_000
      )
    ).toEqual({ kind: 'rate-limited', retryAfterSeconds: 119 });
  });

  it('returns distinct recovery paths for known provider failures', () => {
    expect(
      getDiscoveryFeedFailure({
        response: { status: 409, data: { code: 'RECONNECT_REQUIRED' } },
      })
    ).toEqual({ kind: 'reconnect' });
    expect(
      getDiscoveryFeedFailure({
        response: { status: 409, data: { code: 'PROVIDER_SETUP_REQUIRED' } },
      })
    ).toEqual({ kind: 'setup-required' });
    expect(
      getDiscoveryFeedFailure({
        response: { status: 404, data: { code: 'PROVIDER_LIST_NOT_FOUND' } },
      })
    ).toEqual({ kind: 'list-not-found' });
    expect(
      getDiscoveryFeedFailure({ response: { status: 404, data: {} } })
    ).toEqual({
      kind: 'temporary',
    });
    expect(getDiscoveryFeedFailure(new Error('offline'))).toEqual({
      kind: 'temporary',
    });
  });
});
