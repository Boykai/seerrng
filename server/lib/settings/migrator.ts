import type { AllSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';
import {
  readPrivateSettingsFile,
  writePrivateSettingsFile,
} from './fileSecurity';

const migrationsDir = path.join(__dirname, 'migrations');

export const getSettingsBackupPath = (settingsPath: string): string => {
  const parsed = path.parse(settingsPath);
  return path.join(parsed.dir, `${parsed.name}.old${parsed.ext || '.json'}`);
};

export const getSettingsMigrationFiles = (files: string[]): string[] =>
  files
    .filter((file) => /^\d+_[^.]+\.(?:js|ts)$/.test(file))
    .sort((left, right) => left.localeCompare(right));

export const runMigrations = async (
  settings: AllSettings,
  SETTINGS_PATH: string
): Promise<AllSettings> => {
  let migrated = settings;

  try {
    // we read old backup and create a backup of currents settings
    const BACKUP_PATH = getSettingsBackupPath(SETTINGS_PATH);
    let oldBackup: string | null = null;
    try {
      oldBackup = await readPrivateSettingsFile(BACKUP_PATH);
    } catch {
      /* empty */
    }
    await writePrivateSettingsFile(
      BACKUP_PATH,
      JSON.stringify(settings, undefined, ' ')
    );

    const migrations = getSettingsMigrationFiles(
      await fs.readdir(migrationsDir)
    );

    const settingsBefore = JSON.stringify(migrated);

    for (const migration of migrations) {
      try {
        logger.debug(`Checking migration '${migration}'...`, {
          label: 'Settings Migrator',
        });
        const { default: migrationFn } = await import(
          path.join(migrationsDir, migration)
        );
        const newSettings = await migrationFn(structuredClone(migrated));
        if (JSON.stringify(migrated) !== JSON.stringify(newSettings)) {
          logger.debug(`Migration '${migration}' has been applied.`, {
            label: 'Settings Migrator',
          });
        }
        migrated = newSettings;
      } catch (e) {
        // we stop Seerr if the migration failed
        logger.error(
          `Error while running migration '${migration}': ${e.message}\n${e.stack}`,
          {
            label: 'Settings Migrator',
          }
        );
        logger.error(
          'A common cause for this error is a permission issue with your configuration folder, a network issue or a corrupted database.',
          {
            label: 'Settings Migrator',
          }
        );
        process.exit(1);
      }
    }

    const settingsAfter = JSON.stringify(migrated);

    if (settingsBefore !== settingsAfter) {
      // a migration occured
      // we check that the new config will be saved
      await writePrivateSettingsFile(
        SETTINGS_PATH,
        JSON.stringify(migrated, undefined, ' ')
      );
      const fileSaved = JSON.parse(
        await readPrivateSettingsFile(SETTINGS_PATH)
      );
      if (JSON.stringify(fileSaved) !== settingsAfter) {
        // something went wrong while saving file
        throw new Error('Unable to save settings after migration.');
      }
    } else if (oldBackup) {
      // no migration occured
      // we save the old backup (to avoid settings.json and settings.old.json being the same)
      await writePrivateSettingsFile(BACKUP_PATH, oldBackup.toString());
    }
  } catch (e) {
    // we stop Seerr if the migration failed
    logger.error(
      `Something went wrong while running settings migrations: ${e.message}`,
      {
        label: 'Settings Migrator',
      }
    );
    logger.error(
      'A common cause for this issue is a permission error of your configuration folder.',
      {
        label: 'Settings Migrator',
      }
    );
    process.exit(1);
  }

  return migrated;
};
