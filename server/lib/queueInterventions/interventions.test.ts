import ExternalAPI from '@server/api/externalapi';
import RadarrAPI from '@server/api/servarr/radarr';
import { getRepository } from '@server/datasource';
import QueueIntervention from '@server/entity/QueueIntervention';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import {
  queueIdentity,
  safeDiagnostic,
  serviceAuthority,
  type InterventionQueueItem,
} from './identity';
import {
  importIntervention,
  observeInterventionQueue,
  previewIntervention,
  rejectIntervention,
} from './index';
import {
  importCandidates,
  importTargets,
  selectImportFiles,
  type ManualImportSource,
} from './manualImport';
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
const mockRadarrMovieLookup = () =>
  mock.method(
    ExternalAPI.prototype as unknown as {
      request: (method: string, endpoint: string) => Promise<unknown>;
    },
    'request',
    async (method: string, endpoint: string) => {
      assert.equal(method, 'GET');
      assert.equal(endpoint, '/movie/15');
      return {
        data: {
          id: 15,
          tmdbId: 101,
          title: 'Movie release',
          year: 2024,
        },
      };
    }
  );
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
      'secret-value api_key=other-token passkey=query-secret token=access-secret Bearer header-secret https://user:password@host/path',
      server.apiKey
    ),
    '[redacted] api_key=[redacted] passkey=[redacted] token=[redacted] Bearer [redacted] https://[redacted]@host/path'
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
  mockRadarrMovieLookup();
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
    initial.fingerprint,
    initial.target?.id
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
  const source: ManualImportSource = {
    getManualImportCandidates: async () => [
      candidate,
      { ...candidate, id: 8, movieId: 99 },
      { ...candidate, id: 9, path: '/downloads/unrelated/file.mkv' },
      { ...candidate, id: 10, path: '/downloads/movie' },
    ],
    getTargets: async () => [],
    getTarget: async (id) => ({ id, title: 'Movie release' }),
  };
  const { candidates: files } = await importCandidates('radarr', source, item);
  assert.deepEqual(
    files.map((file) => file.eligible),
    [true, false, false, false]
  );
  assert.throws(() => selectImportFiles(files, [8]), /confirmed/);
  assert.throws(() => selectImportFiles(files, [9]), /confirmed/);
  assert.throws(() => selectImportFiles(files, [10]), /confirmed/);
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
  mockRadarrMovieLookup();
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
    () =>
      importIntervention(
        row.id,
        1,
        [7],
        'copy',
        preview.fingerprint,
        preview.target?.id
      ),
    /preview changed/i
  );
  assert.equal(submission.mock.callCount(), 0);
});

it('builds backend-specific manual import payloads for movies, series, albums and books', async () => {
  const cases = [
    {
      type: 'radarr' as const,
      target: { id: 15, title: 'Movie' },
      row: candidate,
      expected: { movieId: 15 },
    },
    {
      type: 'sonarr' as const,
      target: { id: 15, title: 'Series' },
      row: {
        ...candidate,
        seriesId: 15,
        series: { id: 15 },
        episodes: [{ id: 151 }],
        releaseType: 'singleEpisode',
      },
      expected: { seriesId: 15, episodeIds: [151] },
    },
    {
      type: 'lidarr' as const,
      target: { id: 15, title: 'Album', parentId: 8 },
      row: {
        id: 7,
        path: '/downloads/movie/file.mkv',
        name: 'file.mkv',
        album: { id: 15 },
        artist: { id: 8 },
        albumReleaseId: 150,
        tracks: [{ id: 151 }, { id: 152 }],
        quality: { quality: { id: 1 } },
        size: 100,
      },
      expected: {
        artistId: 8,
        albumId: 15,
        albumReleaseId: 150,
        trackIds: [151, 152],
      },
    },
    {
      type: 'readarr' as const,
      target: { id: 15, title: 'Book', parentId: 8 },
      row: {
        id: 7,
        path: '/downloads/movie/file.mkv',
        name: 'file.mkv',
        book: { id: 15 },
        author: { id: 8 },
        foreignEditionId: 'OL123M',
        quality: { quality: { id: 1 } },
        size: 100,
      },
      expected: { authorId: 8, bookId: 15, foreignEditionId: 'OL123M' },
    },
  ];

  for (const testCase of cases) {
    const source: ManualImportSource = {
      getManualImportCandidates: async () => [testCase.row],
      getTargets: async () => [testCase.target],
      getTarget: async (id) =>
        id === testCase.target.id ? testCase.target : undefined,
    };
    const { candidates, target } = await importCandidates(
      testCase.type,
      source,
      item,
      testCase.target.id
    );
    assert.equal(target?.id, testCase.target.id, testCase.type);
    assert.equal(candidates[0].eligible, true, testCase.type);
    for (const [field, value] of Object.entries(testCase.expected))
      assert.deepEqual(candidates[0].file[field], value, testCase.type);
  }
});

it('searches only existing bounded backend library targets and caps the result list', async () => {
  const source: ManualImportSource = {
    getManualImportCandidates: async () => [],
    getTargets: async () => [
      { id: 1, title: 'Alpha', subtitle: 'Artist' },
      { id: 2, title: 'Alpha Extended', subtitle: 'Artist' },
      ...Array.from({ length: 30 }, (_, index) => ({
        id: index + 3,
        title: `Alpha item ${index}`,
      })),
    ],
    getTarget: async () => undefined,
  };
  const results = await importTargets(source, 'alpha');
  assert.equal(results.length, 20);
  assert.equal(results[0].id, 1);
  assert.deepEqual(await importTargets(source, ' no match '), []);
  await assert.rejects(() => importTargets(source, 'x'), /between 2 and 120/i);
});

it('refuses manual import previews with too many files to review', async () => {
  const source: ManualImportSource = {
    getManualImportCandidates: async () =>
      Array.from({ length: 1001 }, (_, index) => ({ id: index + 1 })),
    getTargets: async () => [],
    getTarget: async (id) => ({ id, title: 'Movie release' }),
  };
  await assert.rejects(
    () => importCandidates('radarr', source, item),
    /too many files for a safe manual import preview/i
  );
});
