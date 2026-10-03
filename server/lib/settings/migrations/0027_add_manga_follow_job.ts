import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addMangaFollowJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0027_add_manga_follow_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['manga-follow'] ??= { schedule: '0 7,37 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0027_add_manga_follow_job');
  return settings as AllSettings;
};

export default addMangaFollowJob;
