import { describe, expect, it } from 'vitest';
import addMangaLibraryScanJob from './0021_add_manga_library_scan_job';

describe('manga library scan job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addMangaLibraryScanJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['manga-library-scan']).toEqual({
      schedule: '0 45 5 * * *',
    });
    expect(defaults.migrations).toEqual(['0021_add_manga_library_scan_job']);

    const customized = addMangaLibraryScanJob({
      jobs: {
        'manga-library-scan': { schedule: '0 0 6 * * *', enabled: false },
      },
    });
    expect(customized.jobs['manga-library-scan']).toEqual({
      schedule: '0 0 6 * * *',
      enabled: false,
    });

    const applied = addMangaLibraryScanJob({
      jobs: {},
      migrations: ['0021_add_manga_library_scan_job'],
    });
    expect(applied.jobs['manga-library-scan']).toBeUndefined();
    expect(applied.migrations).toEqual(['0021_add_manga_library_scan_job']);
  });
});
