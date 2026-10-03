import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addMangaProgressJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0026_add_manga_progress_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['manga-progress'] ??= { schedule: '0 */2 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0026_add_manga_progress_job');
  return settings as AllSettings;
};

export default addMangaProgressJob;
