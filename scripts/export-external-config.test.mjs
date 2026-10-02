import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('./export-external-config.mjs', import.meta.url)
);

const baseSettings = {
  clientId: 'fixture-client',
  main: {},
  network: {},
  plex: {},
  jellyfin: {},
  tautulli: {},
  radarr: [],
  sonarr: [],
  notifications: {},
};

const exportSettings = (settings) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'export-external-config-'));
  try {
    const settingsPath = path.join(directory, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify(settings));
    const result = spawnSync(process.execPath, [script, settingsPath], {
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

test('exports Suwayomi instances with their credentials', () => {
  const suwayomi = [
    {
      id: 0,
      name: 'Suwayomi',
      hostname: '127.0.0.1',
      port: 4567,
      useSsl: false,
      isDefault: true,
      authMode: 'UI_LOGIN',
      username: 'fixture-user',
      password: 'fixture-password',
      sourceAllowlist: ['4000000000000000001'],
      preferredLanguages: ['en'],
      scanlatorPreference: ['Group A'],
      requireCbz: true,
    },
  ];

  assert.deepEqual(
    exportSettings({ ...baseSettings, suwayomi }).suwayomi,
    suwayomi
  );
});

test('exports an empty Suwayomi list when none is configured', () => {
  assert.deepEqual(exportSettings(baseSettings).suwayomi, []);
});
