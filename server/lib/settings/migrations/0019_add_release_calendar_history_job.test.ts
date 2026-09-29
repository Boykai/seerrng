import { describe, expect, it } from 'vitest';
import addReleaseCalendarHistoryJob from './0019_add_release_calendar_history_job';

describe('release calendar history job settings migration', () => {
  it('adds the default schedule and preserves an operator schedule', () => {
    const defaults = addReleaseCalendarHistoryJob({ jobs: {}, migrations: [] });
    expect(defaults.jobs['release-calendar-history']).toEqual({
      schedule: '0 0 4 * * *',
    });
    const customized = addReleaseCalendarHistoryJob({
      jobs: {
        'release-calendar-history': { schedule: '0 0 5 * * *', enabled: false },
      },
      migrations: [],
    });
    expect(customized.jobs['release-calendar-history']).toEqual({
      schedule: '0 0 5 * * *',
      enabled: false,
    });
    expect(
      addReleaseCalendarHistoryJob({
        jobs: {},
        migrations: ['0019_add_release_calendar_history_job'],
      }).jobs['release-calendar-history']
    ).toBeUndefined();
  });
});
