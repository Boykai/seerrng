import { describe, expect, it } from 'vitest';
import addMangaFollowJob from './0027_add_manga_follow_job';

describe('manga follow job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addMangaFollowJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['manga-follow']).toEqual({
      schedule: '0 7,37 * * * *',
    });
    expect(defaults.migrations).toEqual(['0027_add_manga_follow_job']);

    const customized = addMangaFollowJob({
      jobs: {
        'manga-follow': { schedule: '0 15 */6 * * *', enabled: false },
      },
    });
    expect(customized.jobs['manga-follow']).toEqual({
      schedule: '0 15 */6 * * *',
      enabled: false,
    });
    expect(customized.migrations).toEqual(['0027_add_manga_follow_job']);

    const applied = addMangaFollowJob({
      jobs: {},
      migrations: ['0027_add_manga_follow_job'],
    });
    expect(applied.jobs['manga-follow']).toBeUndefined();
    expect(applied.migrations).toEqual(['0027_add_manga_follow_job']);
  });
});
