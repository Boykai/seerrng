import {
  MANGA_SUMMARY_BATCH_SIZE,
  mangaSummariesKey,
} from '@app/hooks/useMangaSummaries';
import { describe, expect, it } from 'vitest';

describe('mangaSummariesKey', () => {
  it('asks for unique AniList IDs in one request with encoded commas', () => {
    expect(mangaSummariesKey([30013, 101, 30013, 7])).toBe(
      '/api/v1/manga?ids=30013%2C101%2C7'
    );
  });

  it('drops IDs the API would refuse', () => {
    expect(mangaSummariesKey([0, -1, 1.5, Number.NaN, 2_147_483_648, 12])).toBe(
      '/api/v1/manga?ids=12'
    );
  });

  it('caps the request at the server batch size', () => {
    const ids = Array.from({ length: 60 }, (_, index) => index + 1);
    const key = mangaSummariesKey(ids);

    expect(MANGA_SUMMARY_BATCH_SIZE).toBe(50);
    expect(key?.split('=')[1].split('%2C')).toHaveLength(50);
    expect(key).toMatch(/ids=1%2C2%2C.*%2C50$/);
  });

  it('makes no request without IDs', () => {
    expect(mangaSummariesKey([])).toBeNull();
    expect(mangaSummariesKey([0, -3])).toBeNull();
  });
});
