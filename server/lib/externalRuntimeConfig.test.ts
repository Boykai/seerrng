import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
      notifications: { agents: {} },
      network: {},
    });

    const config = loadExternalRuntimeConfig();

    assert.equal(config.radarr[0].is4k, false);
    assert.equal(config.radarr[1].is4k, true);
    assert.equal(config.sonarr[0].is4k, false);
    assert.equal(config.lidarr[0].is4k, false);
    assert.equal(config.readarr[0].is4k, false);
  });
});

describe('external runtime Suwayomi configuration', () => {
  const base = {
    clientId: 'client-id',
    vapidPublic: 'vapid-public',
    vapidPrivate: 'vapid-private',
    main: {},
    plex: {},
    jellyfin: {},
    oidc: {},
    tautulli: {},
    radarr: [],
    sonarr: [],
    lidarr: [],
    readarr: [],
    notifications: { agents: {} },
    network: {},
  };

  it('treats a missing section as no instances', () => {
    process.env.SEERR_EXTERNAL_CONFIG = JSON.stringify(base);

    assert.deepEqual(loadExternalRuntimeConfig().suwayomi, []);
  });

  it('keeps configured instances, credentials included', () => {
    const instance = {
      id: 0,
      hostname: 'suwayomi.local',
      port: 4567,
      authMode: 'UI_LOGIN',
      username: 'fake-user',
      password: randomUUID(),
    };
    process.env.SEERR_EXTERNAL_CONFIG = JSON.stringify({
      ...base,
      suwayomi: [instance],
    });

    assert.deepEqual(loadExternalRuntimeConfig().suwayomi, [instance]);
  });

  it('rejects a section that is not a list of objects', () => {
    for (const suwayomi of [{}, 'suwayomi', [null], [1]]) {
      process.env.SEERR_EXTERNAL_CONFIG = JSON.stringify({
        ...base,
        suwayomi,
      });
      assert.throws(
        () => loadExternalRuntimeConfig(),
        /SEERR_EXTERNAL_CONFIG\.suwayomi/
      );
    }
  });
});
