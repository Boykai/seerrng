import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addMangaSourceResolveJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0024_add_manga_source_resolve_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['manga-source-resolve'] ??= { schedule: '0 */10 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0024_add_manga_source_resolve_job');
  return settings as AllSettings;
};

export default addMangaSourceResolveJob;
