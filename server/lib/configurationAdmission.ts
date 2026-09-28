import requestAdmissionCoordinator from '@server/lib/requestAdmission';
import { getSettings, type AllSettings } from '@server/lib/settings';
import AsyncLock from '@server/utils/asyncLock';
import { createHash } from 'node:crypto';

export type ConfigurationAdmissionSection =
  'jellyfin' | 'oidc' | 'plex' | 'tautulli' | 'discoveryIntegrations';

const configurationAdmissionLock = new AsyncLock();

export interface ConfigurationAuthoritySnapshot {
  section: ConfigurationAdmissionSection;
  authorityKey: string;
}

const configurationAuthorityValue = (
  section: ConfigurationAdmissionSection,
  settings: Pick<
    AllSettings,
    'main' | 'plex' | 'jellyfin' | 'oidc' | 'tautulli'
  > &
    Partial<Pick<AllSettings, 'discoveryIntegrations'>>
): unknown => {
  if (section === 'plex') {
    return {
      main: {
        mediaServerType: settings.main.mediaServerType,
        enableSpecialEpisodes: settings.main.enableSpecialEpisodes,
      },
      configuration: {
        ...settings.plex,
        libraries: settings.plex.libraries.map(({ lastScan, ...library }) => {
          void lastScan;
          return library;
        }),
      },
    };
  }

  if (section === 'jellyfin') {
    return {
      main: {
        mediaServerType: settings.main.mediaServerType,
        enableSpecialEpisodes: settings.main.enableSpecialEpisodes,
      },
      configuration: settings.jellyfin,
    };
  }

  return settings[section];
};

export const getConfigurationAuthorityKey = (
  section: ConfigurationAdmissionSection,
  settings: Pick<
    AllSettings,
    'main' | 'plex' | 'jellyfin' | 'oidc' | 'tautulli'
  > &
    Partial<Pick<AllSettings, 'discoveryIntegrations'>> = getSettings()
): string =>
  createHash('sha256')
    .update(JSON.stringify(configurationAuthorityValue(section, settings)))
    .digest('hex');

export const captureConfigurationAuthority = (
  section: ConfigurationAdmissionSection,
  settings: Pick<
    AllSettings,
    'main' | 'plex' | 'jellyfin' | 'oidc' | 'tautulli'
  > &
    Partial<Pick<AllSettings, 'discoveryIntegrations'>> = getSettings()
): ConfigurationAuthoritySnapshot => ({
  section,
  authorityKey: getConfigurationAuthorityKey(section, settings),
});

export class ConfigurationAuthorityChangedError extends Error {
  constructor(section: ConfigurationAdmissionSection) {
    super(`${section} configuration authority changed during operation.`);
    this.name = 'ConfigurationAuthorityChangedError';
  }
}

export const runWithConfigurationAdmission = <Result>(
  section: ConfigurationAdmissionSection,
  callback: () => Promise<Result>
): Promise<Result> => {
  const resource = `configuration:${section}`;
  return requestAdmissionCoordinator.run([resource], () =>
    configurationAdmissionLock.dispatch(resource, callback)
  );
};

export const runWithConfigurationAdmissions = <Result>(
  sections: ConfigurationAdmissionSection[],
  callback: () => Promise<Result>
): Promise<Result> => {
  const orderedSections = [...new Set(sections)].sort();

  const runNext = (index: number): Promise<Result> =>
    index >= orderedSections.length
      ? callback()
      : runWithConfigurationAdmission(orderedSections[index], () =>
          runNext(index + 1)
        );

  return runNext(0);
};

export const runWithConfigurationSnapshot = <Result>(
  snapshot: ConfigurationAuthoritySnapshot,
  callback: () => Promise<Result>
): Promise<Result> =>
  runWithConfigurationAdmission(snapshot.section, async () => {
    if (
      getConfigurationAuthorityKey(snapshot.section) !== snapshot.authorityKey
    ) {
      throw new ConfigurationAuthorityChangedError(snapshot.section);
    }

    return callback();
  });
