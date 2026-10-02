import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addMangaLibraryScanJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0021_add_manga_library_scan_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['manga-library-scan'] ??= { schedule: '0 45 5 * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0021_add_manga_library_scan_job');
  return settings as AllSettings;
};

export default addMangaLibraryScanJob;
