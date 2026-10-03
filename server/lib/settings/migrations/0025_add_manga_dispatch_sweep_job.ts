import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addMangaDispatchSweepJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0025_add_manga_dispatch_sweep_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['manga-dispatch-sweep'] ??= { schedule: '0 */5 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0025_add_manga_dispatch_sweep_job');
  return settings as AllSettings;
};

export default addMangaDispatchSweepJob;
