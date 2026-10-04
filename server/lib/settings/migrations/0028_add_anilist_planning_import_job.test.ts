import { describe, expect, it } from 'vitest';
import addAnilistPlanningImportJob from './0028_add_anilist_planning_import_job';

describe('AniList Planning import job settings migration', () => {
  it('adds the default schedule once and keeps an operator schedule', () => {
    const defaults = addAnilistPlanningImportJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['anilist-planning-import']).toEqual({
      schedule: '0 23 * * * *',
    });
    expect(defaults.migrations).toEqual([
      '0028_add_anilist_planning_import_job',
    ]);

    const customized = addAnilistPlanningImportJob({
      jobs: {
        'anilist-planning-import': {
          schedule: '0 0 */6 * * *',
          enabled: false,
        },
      },
    });
    expect(customized.jobs['anilist-planning-import']).toEqual({
      schedule: '0 0 */6 * * *',
      enabled: false,
    });
    expect(customized.migrations).toEqual([
      '0028_add_anilist_planning_import_job',
    ]);

    const applied = addAnilistPlanningImportJob({
      jobs: {},
      migrations: ['0028_add_anilist_planning_import_job'],
    });
    expect(applied.jobs['anilist-planning-import']).toBeUndefined();
    expect(applied.migrations).toEqual([
      '0028_add_anilist_planning_import_job',
    ]);
  });
});
