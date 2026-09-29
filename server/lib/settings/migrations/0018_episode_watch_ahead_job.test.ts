import { describe, expect, it } from 'vitest';
import addEpisodeWatchAheadJob from './0018_episode_watch_ahead_job';

describe('episode watch-ahead job settings migration', () => {
  it('adds a bounded default schedule without replacing an operator schedule', () => {
    const defaults = addEpisodeWatchAheadJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['jellyfin-watch-ahead']).toEqual({
      schedule: '*/30 * * * * *',
    });
    const customized = addEpisodeWatchAheadJob({
      jobs: {
        'jellyfin-watch-ahead': { schedule: '0 * * * * *', enabled: false },
      },
      migrations: [],
    });
    expect(customized.jobs['jellyfin-watch-ahead']).toEqual({
      schedule: '0 * * * * *',
      enabled: false,
    });
  });
});
