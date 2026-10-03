import { describe, expect, it } from 'vitest';
import addMangaProgressJob from './0026_add_manga_progress_job';

describe('manga progress job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addMangaProgressJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['manga-progress']).toEqual({
      schedule: '0 */2 * * * *',
    });
    expect(defaults.migrations).toEqual(['0026_add_manga_progress_job']);

    const customized = addMangaProgressJob({
      jobs: {
        'manga-progress': { schedule: '0 */10 * * * *', enabled: false },
      },
    });
    expect(customized.jobs['manga-progress']).toEqual({
      schedule: '0 */10 * * * *',
      enabled: false,
    });

    const applied = addMangaProgressJob({
      jobs: {},
      migrations: ['0026_add_manga_progress_job'],
    });
    expect(applied.jobs['manga-progress']).toBeUndefined();
    expect(applied.migrations).toEqual(['0026_add_manga_progress_job']);
  });
});
