import QuestarrNGAPI from '@server/api/software/questarrng';
import ROMarrNGAPI from '@server/api/software/romarrng';
import type { SoftwareCatalogGame } from '@server/api/software/types';
import { getRepository } from '@server/datasource';
import SoftwareRequest, {
  type SoftwareRequestCategory,
  type SoftwareRequestStatus,
} from '@server/entity/SoftwareRequest';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, it, mock } from 'node:test';
import { getReleaseCalendar } from './index';
import { parseCalendarQuery } from './query';

setupTestDb();
afterEach(() => mock.restoreAll());

const range = { start: '2026-09-01', end: '2026-10-01' };

const configureProviders = () => {
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];
  settings.lidarr = [];
  settings.readarr = [];
  settings.main.enabledMediaCategories = {
    ...settings.main.enabledMediaCategories,
    game: true,
    retro: true,
    modern: true,
  };
  settings.softwareAcquisition = {
    romarr: {
      hostname: '127.0.0.1',
      port: 6868,
      useSsl: false,
      baseUrl: '',
      apiKey: 'romarr-test-key',
    },
    questarr: {
      hostname: '127.0.0.1',
      port: 3000,
      useSsl: false,
      baseUrl: '',
      apiKey: 'questarr-test-key',
    },
    emulationCatalogProvider: 'romarr',
    emulationSystemGroups: {},
  };
};

let requestNumber = 0;
const addSoftwareRequest = async (options: {
  requestedById: number;
  category: SoftwareRequestCategory;
  catalogId: number;
  status?: SoftwareRequestStatus;
  platformName?: string;
  operatingSystem?: SoftwareRequest['operatingSystem'];
  architecture?: SoftwareRequest['architecture'];
}) => {
  const repository = getRepository(SoftwareRequest);
  requestNumber += 1;
  const categoryProvider = options.category === 'game' ? 'questarr' : 'romarr';
  return repository.save(
    repository.create({
      requestedById: options.requestedById,
      category: options.category,
      provider: categoryProvider,
      status: options.status ?? 'approved',
      externalRequestId: `calendar-test:${requestNumber}`,
      catalogId: options.catalogId,
      title: `Requested game ${options.catalogId}`,
      platformName: options.platformName ?? null,
      operatingSystem: options.operatingSystem ?? null,
      architecture: options.architecture ?? null,
      attempt: 0,
    })
  );
};

const game = (
  igdbId: number,
  releaseDate = '2026-09-15'
): SoftwareCatalogGame => ({
  id: `igdb-${igdbId}`,
  igdbId,
  title: `Catalog game ${igdbId}`,
  summary: '',
  coverUrl: '',
  releaseDate,
  platforms: [],
  platformOptions: [],
  genres: [],
});

it('keeps software releases in personal calendars and respects shared scope', async () => {
  configureProviders();
  await addSoftwareRequest({
    requestedById: 1,
    category: 'game',
    catalogId: 42,
    operatingSystem: 'linux',
    architecture: 'x64',
    status: 'approved',
  });
  await addSoftwareRequest({
    requestedById: 2,
    category: 'game',
    catalogId: 42,
    operatingSystem: 'windows',
    architecture: 'x64',
    status: 'available',
  });
  await addSoftwareRequest({
    requestedById: 1,
    category: 'retro',
    catalogId: 42,
    platformName: 'Nintendo Entertainment System',
    status: 'downloading',
  });
  await addSoftwareRequest({
    requestedById: 2,
    category: 'modern',
    catalogId: 43,
    platformName: 'Steam Deck',
  });
  const questarrLookup = mock.method(
    QuestarrNGAPI.prototype,
    'getCatalogGame',
    async (igdbId: number) => game(igdbId)
  );
  const romarrLookup = mock.method(
    ROMarrNGAPI.prototype,
    'getCatalogGame',
    async (igdbId: number) => game(igdbId)
  );

  const personal = await getReleaseCalendar(
    parseCalendarQuery({ ...range, mediaType: 'software' }, false, false),
    1,
    false,
    { includeDateHistory: false }
  );
  assert.deepEqual(
    personal.results.map((item) => [
      item.id,
      item.platformName,
      item.available,
    ]),
    [
      ['software:game:42', 'Linux · x64', false],
      ['software:retro:42', 'Nintendo Entertainment System', false],
    ]
  );

  const shared = await getReleaseCalendar(
    parseCalendarQuery(
      { ...range, scope: 'all', mediaType: 'software' },
      true,
      false
    ),
    1,
    false,
    { includeDateHistory: false }
  );
  assert.deepEqual(
    shared.results.map((item) => [
      item.id,
      item.source,
      item.platformName,
      item.available,
    ]),
    [
      ['software:game:42', 'questarr', 'Linux · x64, Windows · x64', true],
      ['software:modern:43', 'romarr', 'Steam Deck', false],
      ['software:retro:42', 'romarr', 'Nintendo Entertainment System', false],
    ]
  );
  assert.deepEqual(
    questarrLookup.mock.calls.map((call) => call.arguments[0]),
    [42, 42]
  );
  assert.deepEqual(
    romarrLookup.mock.calls.map((call) => call.arguments[0]),
    [42, 42, 43]
  );
});

it('omits invalid dates and reports an unavailable software catalog without leaking errors', async () => {
  configureProviders();
  await addSoftwareRequest({
    requestedById: 1,
    category: 'retro',
    catalogId: 44,
    platformName: 'NES',
  });
  await addSoftwareRequest({
    requestedById: 1,
    category: 'modern',
    catalogId: 45,
    platformName: 'Steam Deck',
  });
  mock.method(
    ROMarrNGAPI.prototype,
    'getCatalogGame',
    async (igdbId: number) => {
      if (igdbId === 44) return game(igdbId, '2026-02-30');
      throw new Error('upstream failure includes private-api-key');
    }
  );

  const result = await getReleaseCalendar(
    parseCalendarQuery(
      { ...range, scope: 'all', mediaType: 'software' },
      true,
      false
    ),
    1,
    false,
    { includeDateHistory: false }
  );
  assert.deepEqual(result.results, []);
  assert.deepEqual(result.partialSources, [{ source: 'romarr' }]);
  assert.equal(JSON.stringify(result).includes('private-api-key'), false);
});
