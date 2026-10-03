import { describe, expect, it } from 'vitest';
import addMangaSourceResolveJob from './0024_add_manga_source_resolve_job';

describe('manga source resolve job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addMangaSourceResolveJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['manga-source-resolve']).toEqual({
      schedule: '0 */10 * * * *',
    });
    expect(defaults.migrations).toEqual(['0024_add_manga_source_resolve_job']);

    const customized = addMangaSourceResolveJob({
      jobs: {
        'manga-source-resolve': { schedule: '0 0 * * * *', enabled: false },
      },
    });
    expect(customized.jobs['manga-source-resolve']).toEqual({
      schedule: '0 0 * * * *',
      enabled: false,
    });

    const applied = addMangaSourceResolveJob({
      jobs: {},
      migrations: ['0024_add_manga_source_resolve_job'],
    });
    expect(applied.jobs['manga-source-resolve']).toBeUndefined();
    expect(applied.migrations).toEqual(['0024_add_manga_source_resolve_job']);
  });
});
