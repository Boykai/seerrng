import { MediaServerType } from '@server/constants/server';
import {
  getMovieWatchStatus,
  getSeriesWatchStatus,
} from '@server/lib/watchStatus';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('watched status', () => {
  it('shows movie progress only for a watched library title', () => {
    assert.equal(
      getMovieWatchStatus(MediaServerType.PLEX, false).watchedCount,
      0
    );
    assert.deepEqual(getMovieWatchStatus(MediaServerType.PLEX, true), {
      serverType: MediaServerType.PLEX,
      availableCount: 1,
      watchedCount: 1,
      unwatchedCount: 0,
    });
  });

  it('deduplicates HD and 4K episodes and keeps a watched variant', () => {
    const result = getSeriesWatchStatus(
      MediaServerType.JELLYFIN,
      [
        { seasonNumber: 1, episodeNumber: 1, watched: false },
        { seasonNumber: 1, episodeNumber: 1, watched: true },
        { seasonNumber: 1, episodeNumber: 2, watched: false },
        { seasonNumber: 2, episodeNumber: 1, watched: false },
      ],
      true
    );
    assert.equal(result.availableCount, 3);
    assert.equal(result.watchedCount, 1);
    assert.equal(result.unwatchedCount, 2);
    assert.deepEqual(result.seasons, [
      {
        seasonNumber: 1,
        availableCount: 2,
        watchedCount: 1,
        episodes: [
          { seasonNumber: 1, episodeNumber: 1, watched: true },
          { seasonNumber: 1, episodeNumber: 2, watched: false },
        ],
      },
      {
        seasonNumber: 2,
        availableCount: 1,
        watchedCount: 0,
        episodes: [{ seasonNumber: 2, episodeNumber: 1, watched: false }],
      },
    ]);
  });

  it('omits episode detail from poster summaries and invalid entries', () => {
    const result = getSeriesWatchStatus(MediaServerType.EMBY, [
      { seasonNumber: 3, episodeNumber: 2, watched: true },
      { seasonNumber: -1, episodeNumber: 0, watched: true },
    ]);
    assert.equal(result.availableCount, 1);
    assert.equal(result.watchedCount, 1);
    assert.equal(result.seasons, undefined);
  });
});
