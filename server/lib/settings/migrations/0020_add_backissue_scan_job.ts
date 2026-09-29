import type { AllSettings } from '@server/lib/settings';

type SettingsWithJobMigrations = {
  jobs?: Partial<AllSettings['jobs']>;
  migrations?: string[];
};

const addBackIssueScanJob = (
  settings: SettingsWithJobMigrations
): AllSettings => {
  if (settings.migrations?.includes('0020_add_backissue_scan_job')) {
    return settings as AllSettings;
  }

  settings.jobs ??= {};
  settings.jobs['backissue-scan'] ??= { schedule: '0 30 5 * * *' };
  settings.migrations ??= [];
  settings.migrations.push('0020_add_backissue_scan_job');
  return settings as AllSettings;
};

export default addBackIssueScanJob;
