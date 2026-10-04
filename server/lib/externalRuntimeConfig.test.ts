import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { loadExternalRuntimeConfig } from './externalRuntimeConfig';

const originalExternalConfig = process.env.SEERR_EXTERNAL_CONFIG;

afterEach(() => {
  if (originalExternalConfig === undefined) {
    delete process.env.SEERR_EXTERNAL_CONFIG;
  } else {
    process.env.SEERR_EXTERNAL_CONFIG = originalExternalConfig;
  }
});

describe('external runtime Servarr configuration', () => {
  it('normalizes legacy and missing quality-tier flags to standard', () => {
    process.env.SEERR_EXTERNAL_CONFIG = JSON.stringify({
      clientId: 'client-id',
      vapidPublic: 'vapid-public',
      vapidPrivate: 'vapid-private',
      main: {},
      plex: {},
      jellyfin: {},
      oidc: {},
      tautulli: {},
      radarr: [
        { id: 0, is4k: null },
        { id: 1, is4k: true },
      ],
      sonarr: [{ id: 2 }],
      lidarr: [{ id: 3, is4k: null }],
      readarr: [{ id: 4, is4k: false }],
      audiobookshelf: {
        id: 5,
        name: 'Audiobookshelf',
        hostname: 'abs',
        port: 13378,
        apiKey: 'token',
        useSsl: false,
        libraryId: 'books',
        libraryName: 'Books',
        syncEnabled: true,
      },
      notifications: { agents: {} },
      network: {},
    });

    const config = loadExternalRuntimeConfig();

    assert.equal(config.radarr[0].is4k, false);
    assert.equal(config.radarr[1].is4k, true);
    assert.equal(config.sonarr[0].is4k, false);
    assert.equal(config.lidarr[0].is4k, false);
    assert.equal(config.readarr[0].is4k, false);
    assert.equal(config.audiobookshelf?.libraryId, 'books');
  });
});
