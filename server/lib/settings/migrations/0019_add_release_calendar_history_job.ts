import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addReleaseCalendarHistoryJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0019_add_release_calendar_history_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['release-calendar-history'] ??= {
    schedule: '0 0 4 * * *',
  };
  settings.migrations ??= [];
  settings.migrations.push('0019_add_release_calendar_history_job');
  return settings as AllSettings;
};

export default addReleaseCalendarHistoryJob;
