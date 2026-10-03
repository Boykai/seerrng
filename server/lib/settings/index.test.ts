import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Settings, {
  assertSettingsFileSize,
  MAX_SETTINGS_FILE_BYTES,
  type ReadarrSettings,
  type SuwayomiSettings,
} from '.';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { force: true, recursive: true }))
  );
});

describe('assertSettingsFileSize', () => {
  it('allows settings files within the byte limit', () => {
    assert.doesNotThrow(() => assertSettingsFileSize(MAX_SETTINGS_FILE_BYTES));
  });

  it('rejects oversized settings files before reading them', () => {
    assert.throws(
      () => assertSettingsFileSize(MAX_SETTINGS_FILE_BYTES + 1),
      /settings file exceeds maximum size/i
    );
  });

  it('rejects invalid stat sizes', () => {
    assert.throws(() => assertSettingsFileSize(Number.NaN), /settings file/i);
    assert.throws(() => assertSettingsFileSize(-1), /settings file/i);
  });
});

describe('Settings reset', () => {
  it('keeps CSRF protection disabled like a fresh configuration', () => {
    const settings = new Settings();

    settings.reset();

    assert.equal(settings.network.csrfProtection, false);
  });

  it('starts and resets with no Suwayomi instances', () => {
    const settings = new Settings();
    assert.deepStrictEqual(settings.suwayomi, []);

    settings.suwayomi = [{ id: 0 } as SuwayomiSettings];
    settings.reset();

    assert.deepStrictEqual(settings.suwayomi, []);
  });

  it('adds the Suwayomi section to settings files saved before it existed', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-settings-state-')
    );
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const settings = new Settings(undefined, settingsPath, true);
    await settings.load(undefined, true);
    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    delete persisted.suwayomi;
    await fs.writeFile(settingsPath, JSON.stringify(persisted));
    settings.suwayomi = [{ id: 0 } as SuwayomiSettings];

    settings.refreshIfChangedSync();

    assert.deepStrictEqual(settings.suwayomi, []);
  });
});

describe('Public settings', () => {
  it('reports whether a Suwayomi instance is configured', () => {
    const settings = new Settings();
    assert.strictEqual(settings.fullPublicSettings.suwayomiEnabled, false);

    settings.suwayomi = [{ id: 0 } as SuwayomiSettings];

    assert.strictEqual(settings.fullPublicSettings.suwayomiEnabled, true);
  });
  it('reports ebook and audiobook service availability separately', () => {
    const settings = new Settings();
    settings.readarr = [{ serviceType: 'audiobook' } as ReadarrSettings];

    assert.strictEqual(settings.fullPublicSettings.booksEnabled, true);
    assert.strictEqual(settings.fullPublicSettings.ebookServiceEnabled, false);
    assert.strictEqual(
      settings.fullPublicSettings.audiobookServiceEnabled,
      true
    );

    settings.readarr = [{} as ReadarrSettings];

    assert.strictEqual(settings.fullPublicSettings.ebookServiceEnabled, true);
    assert.strictEqual(
      settings.fullPublicSettings.audiobookServiceEnabled,
      false
    );
  });
});

describe('Settings save serialization', () => {
  it('shares first-start secrets across concurrent settings instances', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-settings-state-')
    );
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const first = new Settings(undefined, settingsPath, true);
    const second = new Settings(undefined, settingsPath, true);

    await Promise.all([
      first.load(undefined, true),
      second.load(undefined, true),
    ]);

    assert.strictEqual(first.clientId, second.clientId);
    assert.strictEqual(first.sessionSecret, second.sessionSecret);
    assert.strictEqual(first.vapidPublic, second.vapidPublic);
    assert.strictEqual(first.vapidPrivate, second.vapidPrivate);
  });

  it('rebases cross-instance mutations from the latest persisted state', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-settings-state-')
    );
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const first = new Settings(undefined, settingsPath, true);
    const second = new Settings(undefined, settingsPath, true);
    await Promise.all([
      first.load(undefined, true),
      second.load(undefined, true),
    ]);

    await Promise.all([
      first.persistSection('main', (current) => ({
        ...current,
        applicationTitle: 'First process title',
      })),
      second.persistSection('main', (current) => ({
        ...current,
        youtubeUrl: 'https://www.youtube.com',
      })),
    ]);

    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.strictEqual(persisted.main.applicationTitle, 'First process title');
    assert.strictEqual(persisted.main.youtubeUrl, 'https://www.youtube.com');
    first.refreshIfChangedSync();
    second.refreshIfChangedSync();
    assert.strictEqual(first.main.youtubeUrl, 'https://www.youtube.com');
    assert.strictEqual(second.main.applicationTitle, 'First process title');
  });

  it('does not resurrect keys removed by another settings instance', async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), 'seerr-settings-state-')
    );
    temporaryDirectories.push(directory);
    const settingsPath = path.join(directory, 'settings.json');
    const first = new Settings(undefined, settingsPath, true);
    const second = new Settings(undefined, settingsPath, true);
    await Promise.all([
      first.load(undefined, true),
      second.load(undefined, true),
    ]);

    await first.persistSection('tautulli', {
      hostname: 'tautulli.local',
      apiKey: 'stale-secret',
    });
    second.refreshIfChangedSync();
    assert.strictEqual(second.tautulli.apiKey, 'stale-secret');

    await second.persistSection('tautulli', {});
    await first.persistSection('main', (current) => ({
      ...current,
      applicationTitle: 'Unrelated mutation',
    }));

    const persisted = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    assert.deepStrictEqual(persisted.tautulli, {});
    assert.deepStrictEqual(first.tautulli, {});
  });

  it('writes the snapshot captured by each save call', async () => {
    let releaseFirstWrite: (() => void) | undefined;
    const firstWriteHeld = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    class TestSettings extends Settings {
      public readonly snapshots: string[] = [];

      protected async writeSnapshot(snapshot: string): Promise<void> {
        this.snapshots.push(snapshot);
        if (this.snapshots.length === 1) {
          await firstWriteHeld;
        }
      }
    }

    const settings = new TestSettings();
    settings.main = { ...settings.main, applicationTitle: 'First' };
    const firstSave = settings.save();
    settings.main = { ...settings.main, applicationTitle: 'Second' };
    const secondSave = settings.save();

    releaseFirstWrite?.();
    await Promise.all([firstSave, secondSave]);

    assert.equal(
      JSON.parse(settings.snapshots[0]).main.applicationTitle,
      'First'
    );
    assert.equal(
      JSON.parse(settings.snapshots[1]).main.applicationTitle,
      'Second'
    );
  });

  it('serializes API-key regeneration with other settings mutations', async () => {
    class TestSettings extends Settings {
      public snapshots: string[] = [];

      protected async writeSnapshot(snapshot: string): Promise<void> {
        this.snapshots.push(snapshot);
      }
    }

    const settings = new TestSettings();
    const [main] = await Promise.all([
      settings.regenerateApiKey(),
      settings.persistSection('main', (current) => ({
        ...current,
        applicationTitle: 'Concurrent title',
      })),
    ]);

    assert.ok(main.apiKey);
    assert.equal(settings.main.apiKey, main.apiKey);
    assert.equal(settings.main.applicationTitle, 'Concurrent title');
    assert.equal(
      JSON.parse(settings.snapshots.at(-1) ?? '{}').main.applicationTitle,
      'Concurrent title'
    );
  });
});
