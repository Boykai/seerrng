import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addAnilistPlanningImportJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0028_add_anilist_planning_import_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['anilist-planning-import'] ??= { schedule: '0 23 * * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0028_add_anilist_planning_import_job');
  return settings as AllSettings;
};

export default addAnilistPlanningImportJob;
