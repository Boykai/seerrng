import { describe, expect, it } from 'vitest';
import addMangaDispatchSweepJob from './0025_add_manga_dispatch_sweep_job';

describe('manga dispatch sweep job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addMangaDispatchSweepJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['manga-dispatch-sweep']).toEqual({
      schedule: '0 */5 * * * *',
    });
    expect(defaults.migrations).toEqual(['0025_add_manga_dispatch_sweep_job']);

    const customized = addMangaDispatchSweepJob({
      jobs: {
        'manga-dispatch-sweep': { schedule: '0 */15 * * * *', enabled: false },
      },
    });
    expect(customized.jobs['manga-dispatch-sweep']).toEqual({
      schedule: '0 */15 * * * *',
      enabled: false,
    });

    const applied = addMangaDispatchSweepJob({
      jobs: {},
      migrations: ['0025_add_manga_dispatch_sweep_job'],
    });
    expect(applied.jobs['manga-dispatch-sweep']).toBeUndefined();
    expect(applied.migrations).toEqual(['0025_add_manga_dispatch_sweep_job']);
  });
});
