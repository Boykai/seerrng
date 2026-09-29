import { getSettings, type AllSettings } from '@server/lib/settings';
import { createDeterministicKey } from '@server/utils/deterministicKey';

type MediaServerAuthoritySettings = Pick<AllSettings, 'main' | 'jellyfin'>;

export const getJellyfinAuthAuthorityKey = (
  settings: MediaServerAuthoritySettings = getSettings()
): string =>
  createDeterministicKey(
    JSON.stringify([
      settings.main.mediaServerType,
      settings.main.mediaServerLogin ?? true,
      settings.jellyfin.ip,
      settings.jellyfin.port,
      settings.jellyfin.useSsl ?? false,
      settings.jellyfin.urlBase ?? '',
      settings.jellyfin.externalHostname ?? '',
      settings.jellyfin.serverId,
      settings.jellyfin.apiKey,
      settings.jellyfin.bridgeLoginEnabled ?? false,
      settings.jellyfin.bridgeLoginGeneration ?? 0,
    ])
  );
