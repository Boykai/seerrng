import RadarrAPI from '@server/api/servarr/radarr';
import { getRepository } from '@server/datasource';
import QueueIntervention from '@server/entity/QueueIntervention';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  type InterventionQueueItem,
  queueIdentity,
  safeDiagnostic,
  serviceAuthority,
} from './identity';
import {
  importIntervention,
  observeInterventionQueue,
  previewIntervention,
  rejectIntervention,
} from './index';
import { importCandidates, selectImportFiles } from './manualImport';
setupTestDb();
afterEach(() => mock.restoreAll());
const server = {
  id: 21,
  name: 'Radarr',
  hostname: 'localhost',
  port: 7878,
  useSsl: false,
  baseUrl: '',
  apiKey: 'secret-value',
  syncEnabled: true,
  is4k: false,
} as RadarrSettings;
const item = {
  id: 2,
  title: 'Movie release',
  downloadId: 'download-1',
  movieId: 15,
  size: 100,
  outputPath: '/downloads/movie',
  status: 'completed',
  trackedDownloadStatus: 'warning',
  statusMessages: [
    { title: 'Import blocked', messages: ['permission denied'] },
  ],
} as InterventionQueueItem;
const candidate = {
  id: 7,
  path: '/downloads/movie/file.mkv',
  name: 'file.mkv',
  movieId: 15,
  quality: { quality: { id: 1 } },
  languages: [{ id: 1 }],
  size: 100,
  rejections: [{ reason: 'Existing file is better' }],
};
async function seed() {
  getSettings().radarr = [server];
  await observeInterventionQueue('radarr', server, [item]);
  return getRepository(QueueIntervention).findOneByOrFail({
    serviceId: server.id,
  });
}
it('binds identity to backend authority and download, and redacts diagnostics', () => {
  const authority = serviceAuthority('radarr', server);
  assert.notEqual(
    authority,
    serviceAuthority('radarr', { ...server, apiKey: 'changed' })
  );
  assert.notEqual(
    queueIdentity(authority, item),
    queueIdentity(authority, { ...item, downloadId: 'reused-queue-id' })
  );
  assert.equal(
    safeDiagnostic(
      'secret-value api_key=other-token https://user:password@host/path',
      server.apiKey
    ),
    '[redacted] api_key=[redacted] https://[redacted]@host/path'
  );
});
it('observes warnings durably without marking missing rows resolved from partial recovery snapshots', async () => {
  const row = await seed();
  await observeInterventionQueue('radarr', server, []);
  assert.equal(
    (await getRepository(QueueIntervention).findOneByOrFail({ id: row.id }))
      .state,
    'active'
  );
  await observeInterventionQueue('radarr', server, [
    { ...item, trackedDownloadStatus: 'ok', statusMessages: [] },
  ]);
  assert.equal(
    (await getRepository(QueueIntervention).findOneByOrFail({ id: row.id }))
      .resolution,
    'recovered'
  );
  await observeInterventionQueue('radarr', server, [item]);
  assert.equal(
    (await getRepository(QueueIntervention).findOneByOrFail({ id: row.id }))
      .state,
    'active'
  );
});
it('refuses stale configuration and queue identity before rejection', async () => {
  const row = await seed();
  const deletion = mock.method(
    RadarrAPI.prototype,
    'deleteQueueItem',
    async () => undefined
  );
  mock.method(RadarrAPI.prototype, 'getInterventionQueue', async () => [
    { ...item, downloadId: 'different' },
  ]);
  await assert.rejects(
    () => rejectIntervention(row.id, 1, true, false),
    /download changed/i
  );
  assert.equal(deletion.mock.callCount(), 0);
  getSettings().radarr = [{ ...server, apiKey: 'different' }];
  await assert.rejects(
    () => rejectIntervention(row.id, 1, true, false),
    /configuration changed/i
  );
  assert.equal(deletion.mock.callCount(), 0);
});
it('persists rejection intent before backend deletion and records explicit options', async () => {
  const row = await seed();
  mock.method(RadarrAPI.prototype, 'getInterventionQueue', async () => [item]);
  const deletion = mock.method(
    RadarrAPI.prototype,
    'deleteQueueItem',
    async () => {
      const pending = await getRepository(QueueIntervention).findOneByOrFail({
        id: row.id,
      });
      assert.equal(pending.state, 'rejecting');
      assert.equal(pending.actorId, 3);
    }
  );
  const result = await rejectIntervention(row.id, 3, true, false);
  assert.equal(result.state, 'resolved');
  assert.equal(result.resolution, 'manual-blocklist');
  assert.deepEqual(deletion.mock.calls[0].arguments, [
    item.id,
    { blocklist: true, removeFromClient: false, skipRedownload: false },
  ]);
  assert.ok(!JSON.stringify(result).includes('secret-value'));
});
it('retains uncertain rejection outcomes for review rather than claiming success', async () => {
  const row = await seed();
  mock.method(RadarrAPI.prototype, 'getInterventionQueue', async () => [item]);
  mock.method(RadarrAPI.prototype, 'deleteQueueItem', async () => {
    throw new Error('timeout');
  });
  const result = await rejectIntervention(row.id, 1, false, false);
  assert.equal(result.state, 'failed');
  assert.equal(result.resolution, 'rejection-outcome-unknown');
});
it('previews confirmed files and revalidates selections before submitting an import', async () => {
  const row = await seed();
  mock.method(RadarrAPI.prototype, 'getInterventionQueue', async () => [item]);
  const preview = mock.method(
    RadarrAPI.prototype,
    'getManualImportCandidates',
    async () => [candidate]
  );
  const initial = await previewIntervention(row.id);
  assert.equal(initial.candidates[0].eligible, true);
  assert.ok(!JSON.stringify(initial).includes('/downloads/'));
  const submission = mock.method(
    RadarrAPI.prototype,
    'importManualFiles',
    async () => ({ id: 44, name: 'ManualImport', status: 'queued' })
  );
  const result = await importIntervention(
    row.id,
    1,
    [7],
    'copy',
    initial.fingerprint
  );
  assert.equal(preview.mock.callCount(), 2);
  assert.equal(result.state, 'importing');
  assert.equal(submission.mock.calls[0].arguments[0]![0]!.movieId, 15);
  assert.equal(submission.mock.calls[0].arguments[1], 'copy');
  assert.equal(
    (await getRepository(QueueIntervention).findOneByOrFail({ id: row.id }))
      .commandId,
    44
  );
});
it('rejects mismatched targets, escaped folders, duplicate IDs, and stale candidate selections', async () => {
  const api = {
    getManualImportCandidates: async () => [
      candidate,
      { ...candidate, id: 8, movieId: 99 },
      { ...candidate, id: 9, path: '/downloads/unrelated/file.mkv' },
    ],
  };
  const files = await importCandidates('radarr', api, item);
  assert.deepEqual(
    files.map((file) => file.eligible),
    [true, false, false]
  );
  assert.throws(() => selectImportFiles(files, [8]), /confirmed/);
  assert.throws(() => selectImportFiles(files, [9]), /confirmed/);
  assert.throws(() => selectImportFiles(files, [7, 7]), /distinct/);
  assert.throws(() => selectImportFiles(files, [99]), /changed/);
});
it('requires command completion and a matching import event to resolve an import', async () => {
  const row = await seed();
  await getRepository(QueueIntervention).update(row.id, {
    state: 'importing',
    commandId: 44,
    actionAt: new Date(Date.now() - 300000),
  });
  mock.method(RadarrAPI.prototype, 'getCommand', async () => ({
    id: 44,
    name: 'ManualImport',
    status: 'completed',
  }));
  mock.method(RadarrAPI.prototype, 'getHistory', async () => [
    {
      id: 3,
      downloadId: 'download-1',
      eventType: 'downloadFolderImported',
      date: new Date().toISOString(),
    },
  ]);
  await observeInterventionQueue('radarr', server, []);
  const result = await getRepository(QueueIntervention).findOneByOrFail({
    id: row.id,
  });
  assert.equal(result.state, 'resolved');
  assert.equal(result.resolution, 'manual-import');
});
it('refuses import when a backend reuses a file ID for changed file metadata', async () => {
  const row = await seed();
  mock.method(RadarrAPI.prototype, 'getInterventionQueue', async () => [item]);
  let changed = false;
  mock.method(RadarrAPI.prototype, 'getManualImportCandidates', async () => [
    {
      ...candidate,
      path: changed ? '/downloads/movie/changed.mkv' : candidate.path,
    },
  ]);
  const preview = await previewIntervention(row.id);
  changed = true;
  const submission = mock.method(
    RadarrAPI.prototype,
    'importManualFiles',
    async () => ({ id: 44, name: 'ManualImport', status: 'queued' })
  );
  await assert.rejects(
    () => importIntervention(row.id, 1, [7], 'copy', preview.fingerprint),
    /preview changed/i
  );
  assert.equal(submission.mock.callCount(), 0);
});
