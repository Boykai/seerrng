import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaSummary } from '@server/api/anilist/manga';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { MediaRequestStatus } from '@server/constants/media';
import {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { getSettings, type SuwayomiSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import { graphqlErrors, syntheticFailure } from '@server/test/fakeSuwayomi';
import {
  serveFakeChapterReleases,
  type FakeReleaseChapter,
} from '@server/test/fakeSuwayomiChapterReleases';
import {
  FAKE_TITLE_PREFIX,
  FAKE_URL_PREFIX,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchManga,
  fakeMangaUrl,
  seedDispatchBinding,
  seedDispatchRequest,
  startFakeDispatchSuwayomi,
  type FakeDispatchManga,
  type FakeDispatchSuwayomi,
} from '@server/test/fakeSuwayomiDispatch';
import {
  assertPrivateLogs,
  captureLogs,
  logsOf,
  type CapturedLog,
} from '@server/test/mangaDownloadCopies';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  getMangaReleaseCalendar,
  resetMangaReleaseCalendarCache,
  type MangaCalendarOptions,
} from './manga';
import type { CalendarQuery } from './query';

setupTestDb();

const settings = getSettings();
const savedCategories = settings.main.enabledMediaCategories;
const savedIncludeAdult = settings.main.mangaIncludeAdult;
const savedIncludeNovels = settings.main.mangaIncludeNovels;
const savedSuwayomi = settings.suwayomi;

const NOW = new Date('2026-09-20T12:00:00.000Z');
const fakes: FakeDispatchSuwayomi[] = [];
let instances: SuwayomiSettings[] = [];
let catalog: Map<number, AnilistMangaSummary | null | Error>;
let anilistCalls: number[][];
let logs: CapturedLog[] = [];

const month = (first: string, next: string, scope: 'mine' | 'all' = 'all') =>
  ({
    start: new Date(`${first}T00:00:00.000Z`),
    end: new Date(`${next}T00:00:00.000Z`),
    allDayStart: new Date(`${first}T00:00:00.000Z`),
    allDayEnd: new Date(`${next}T00:00:00.000Z`),
    scope,
    includeUnmonitored: false,
  }) satisfies CalendarQuery;

const september = (overrides: Partial<CalendarQuery> = {}): CalendarQuery => ({
  ...month('2026-09-01', '2026-10-01'),
  ...overrides,
});

const august = (): CalendarQuery => month('2026-08-01', '2026-09-01');

const load = (
  query: CalendarQuery,
  {
    requests = [],
    isAdmin = true,
    ...options
  }: MangaCalendarOptions & {
    requests?: MediaRequest[];
    isAdmin?: boolean;
  } = {}
) =>
  getMangaReleaseCalendar(query, requests, isAdmin, { now: NOW, ...options });

/** A fake serving `mangas` as `instanceId`, added to the configured ones. */
const start = async (
  instanceId: number,
  mangas: FakeDispatchManga[],
  pageSize?: number
) => {
  const fake = await startFakeDispatchSuwayomi(mangas);
  serveFakeChapterReleases(fake, { pageSize });
  fakes.push(fake);
  instances = [...instances, dispatchInstanceFor(fake.server, instanceId)];
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
  return fake;
};

const reads = (fake: FakeDispatchSuwayomi) =>
  fake.server.operations('ChapterReleases');

const readIds = (fake: FakeDispatchSuwayomi) =>
  reads(fake).map(({ variables }) => (variables.ids as unknown[]).map(Number));

const uploaded = (
  id: number,
  chapterNumber: number,
  at: string,
  isDownloaded = false
): FakeReleaseChapter => ({
  id,
  url: fakeChapterUrl(Math.floor(id / 100), id),
  chapterNumber,
  uploadDate: Date.parse(at),
  isDownloaded,
});

/** A chapter without an upload date, stored by Suwayomi at `storedAt`. */
const undated = (
  id: number,
  chapterNumber: number,
  storedAt: string,
  isDownloaded = false
): FakeReleaseChapter => ({
  ...uploaded(id, chapterNumber, storedAt, isDownloaded),
  uploadDate: 0,
  fetchedAt: Math.floor(Date.parse(storedAt) / 1_000),
});

const summary = (
  id: number,
  overrides: Partial<AnilistMangaSummary> = {}
): AnilistMangaSummary => ({
  id,
  titles: { english: `Calendar Manga ${id}` },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  ...overrides,
});

const entry = (
  anilistId: number,
  day: string,
  chapterCount: number,
  available: boolean
) => ({
  id: `suwayomi:manga:${anilistId}:${day}`,
  source: 'suwayomi',
  mediaType: 'manga',
  title: `Calendar Manga ${anilistId}`,
  startsAt: `${day}T00:00:00.000Z`,
  dateType: 'chapter',
  allDay: true,
  mangaId: anilistId,
  chapterCount,
  available,
  is4k: false,
});

const days = (result: { results: { startsAt: string; mangaId?: number }[] }) =>
  result.results.map(
    ({ mangaId, startsAt }) => `${mangaId}:${startsAt.slice(0, 10)}`
  );

/** A friend's request for `anilistId`, bound to `manga`. */
const request = async (
  manga: FakeDispatchManga,
  anilistId: number,
  {
    instanceId = 1,
    status,
    media,
    suwayomiMangaId = manga.id,
    bindingState,
  }: {
    instanceId?: number;
    status?: MediaRequestStatus;
    media?: Media;
    suwayomiMangaId?: number;
    bindingState?: MangaRequestBindingState;
  } = {}
) => {
  await seedDispatchBinding(manga, { anilistId, instanceId });
  return seedDispatchRequest({
    anilistId,
    instanceId,
    status,
    media,
    manifest: {
      bindingSourceId: manga.sourceId,
      bindingUrlHash: hashMangaSourceUrl(manga.url),
      suwayomiMangaId,
      ...(bindingState ? { bindingState } : {}),
    },
  });
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...savedCategories, manga: true };
  settings.main.mangaIncludeAdult = false;
  settings.main.mangaIncludeNovels = false;
  instances = [];
  invalidateSuwayomiClients();
  settings.suwayomi = [];
  resetMangaReleaseCalendarCache();
  logs = captureLogs();
  catalog = new Map();
  anilistCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getMangaSummariesByIds',
    async (ids: readonly number[]) => {
      anilistCalls.push([...ids]);
      if (ids.some((id) => catalog.get(id) instanceof Error))
        throw new Error('The fake AniList is unavailable.');
      return ids.flatMap((id) => {
        const found = catalog.get(id);
        if (found === null || found instanceof Error) return [];
        return [found ?? summary(id)];
      });
    }
  );
});

afterEach(async () => {
  try {
    assertPrivateLogs(logs);
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = savedCategories;
    settings.main.mangaIncludeAdult = savedIncludeAdult;
    settings.main.mangaIncludeNovels = savedIncludeNovels;
    invalidateSuwayomiClients();
    settings.suwayomi = savedSuwayomi;
    resetMangaReleaseCalendarCache();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('manga chapter releases', () => {
  it('shows one entry per title and UTC day, dated by upload or else by when Suwayomi stored the chapter', async () => {
    const manga = fakeDispatchManga(11, {
      chapters: [
        uploaded(1101, 1, '2026-09-01T00:00:00.000Z', true),
        uploaded(1102, 2, '2026-09-03T00:30:00.000Z', true),
        uploaded(1103, 3, '2026-09-03T23:59:59.999Z', true),
        uploaded(1104, 4, '2026-09-03T12:00:00.000Z'),
        undated(1105, 5, '2026-09-07T08:00:00.000Z', true),
        uploaded(1106, 6, '2026-08-31T23:59:59.999Z'),
        uploaded(1107, 7, '2026-09-20T12:00:00.001Z'),
        undated(1108, 8, '2026-08-15T00:00:00.000Z'),
      ],
    });
    const fake = await start(1, [manga]);
    await request(manga, 9001);

    const result = await load(september());

    assert.deepStrictEqual(result, {
      results: [
        entry(9001, '2026-09-01', 1, true),
        entry(9001, '2026-09-03', 3, false),
        entry(9001, '2026-09-07', 1, true),
      ],
      partialSources: [],
      truncated: false,
    });
    assert.deepStrictEqual(fake.operationNames(), ['ChapterReleases']);
    const [read] = reads(fake);
    assert.deepStrictEqual(
      {
        ids: readIds(fake)[0],
        uploadedFrom: read.variables.uploadedFrom,
        uploadedBefore: read.variables.uploadedBefore,
        fetchedFrom: read.variables.fetchedFrom,
        fetchedBefore: read.variables.fetchedBefore,
      },
      {
        ids: [11],
        uploadedFrom: String(Date.parse('2026-09-01T00:00:00.000Z')),
        uploadedBefore: String(Date.parse('2026-09-21T00:00:00.000Z')),
        fetchedFrom: String(Date.parse('2026-09-01T00:00:00.000Z') / 1_000),
        fetchedBefore: String(Date.parse('2026-09-21T00:00:00.000Z') / 1_000),
      }
    );
    assert.deepStrictEqual(anilistCalls, [[9001]]);
    const body = JSON.stringify(result);
    for (const hidden of [FAKE_TITLE_PREFIX, FAKE_URL_PREFIX, 'Fake Chapter'])
      assert.ok(!body.includes(hidden), `The calendar carried ${hidden}`);

    assert.deepStrictEqual(days(await load(august())), [
      '9001:2026-08-15',
      '9001:2026-08-31',
    ]);
  });

  it('counts a chapter number once on its earliest day and chapters without a number one by one', async () => {
    const manga = fakeDispatchManga(12, {
      chapters: [
        uploaded(1201, 5, '2026-09-02T10:00:00.000Z'),
        uploaded(1202, 5, '2026-09-04T10:00:00.000Z', true),
        uploaded(1203, 6, '2026-09-04T09:00:00.000Z', true),
        uploaded(1204, -1, '2026-09-06T10:00:00.000Z', true),
        uploaded(1205, -1, '2026-09-06T11:00:00.000Z'),
      ],
    });
    await start(1, [manga]);
    await request(manga, 9002);

    assert.deepStrictEqual((await load(september())).results, [
      entry(9002, '2026-09-02', 1, true),
      entry(9002, '2026-09-04', 1, true),
      entry(9002, '2026-09-06', 2, false),
    ]);
  });

  it('merges the bound sources of one title across instances', async () => {
    const first = fakeDispatchManga(13, {
      chapters: [
        uploaded(1301, 1, '2026-09-02T00:00:00.000Z', true),
        uploaded(1302, 2, '2026-09-03T00:00:00.000Z'),
      ],
    });
    const second = fakeDispatchManga(14, {
      chapters: [
        uploaded(1401, 1, '2026-09-01T00:00:00.000Z'),
        uploaded(1402, 3, '2026-09-03T05:00:00.000Z', true),
      ],
    });
    const firstFake = await start(1, [first]);
    const secondFake = await start(2, [second]);
    const { media } = await request(first, 9003);
    await request(second, 9003, { instanceId: 2, media });

    assert.deepStrictEqual((await load(september())).results, [
      entry(9003, '2026-09-01', 1, true),
      entry(9003, '2026-09-03', 2, false),
    ]);
    assert.deepStrictEqual(readIds(firstFake), [[13]]);
    assert.deepStrictEqual(readIds(secondFake), [[14]]);
  });

  it('reads nothing while manga is off, for another media type or for a month still ahead', async () => {
    const manga = fakeDispatchManga(15, {
      chapters: [uploaded(1501, 1, '2026-09-02T00:00:00.000Z')],
    });
    const fake = await start(1, [manga]);
    await request(manga, 9004);
    const empty = { results: [], partialSources: [], truncated: false };

    settings.main.enabledMediaCategories = {
      ...savedCategories,
      manga: false,
    };
    assert.deepStrictEqual(await load(september()), empty);
    settings.main.enabledMediaCategories = {
      ...savedCategories,
      manga: true,
    };
    assert.deepStrictEqual(
      await load(september({ mediaType: 'comic' })),
      empty
    );
    assert.deepStrictEqual(
      await load(month('2026-10-01', '2026-11-01')),
      empty
    );
    assert.deepStrictEqual(reads(fake), []);
    assert.deepStrictEqual(anilistCalls, []);

    invalidateSuwayomiClients();
    settings.suwayomi = [];
    assert.deepStrictEqual(await load(september()), empty);
  });

  it('limits the personal scope to the viewer’s requests that were not declined', async () => {
    const mangas = [16, 17, 18].map((id) =>
      fakeDispatchManga(id, {
        inLibrary: true,
        chapters: [uploaded(id * 100 + 1, 1, '2026-09-02T00:00:00.000Z')],
      })
    );
    const fake = await start(1, mangas);
    const kept = await request(mangas[0], 9005);
    const declined = await request(mangas[1], 9006, {
      status: MediaRequestStatus.DECLINED,
    });
    await seedDispatchBinding(mangas[2], { anilistId: 9007 });

    const mine = await load(
      september({ scope: 'mine', includeUnmonitored: true }),
      { requests: [kept.request, declined.request] }
    );

    assert.deepStrictEqual(days(mine), ['9005:2026-09-02']);
    assert.deepStrictEqual(readIds(fake), [[16]]);
    assert.deepStrictEqual(
      await load(september({ scope: 'mine' }), { requests: [] }),
      { results: [], partialSources: [], truncated: false }
    );
    assert.strictEqual(reads(fake).length, 1);
  });

  it('reads every request in the shared scope and adds bound library titles with unmonitored titles', async () => {
    const mangas = [21, 22, 23, 24, 25, 26, 27].map((id) =>
      fakeDispatchManga(id, {
        inLibrary: id !== 26,
        chapters: [uploaded(id * 100 + 1, 1, '2026-09-02T00:00:00.000Z')],
      })
    );
    const fake = await start(1, mangas);
    await request(mangas[0], 9021);
    await request(mangas[1], 9022, { status: MediaRequestStatus.DECLINED });
    await request(mangas[2], 9023, {
      bindingState: MangaRequestBindingState.AWAITING_BINDING,
    });
    await seedDispatchBinding(mangas[3], { anilistId: 9024 });
    await seedDispatchBinding(mangas[4], {
      anilistId: 9025,
      state: MangaBindingState.ORPHANED,
    });
    await seedDispatchBinding(mangas[5], { anilistId: 9026 });
    await seedDispatchBinding(mangas[6], { anilistId: 9027, instanceId: 3 });

    assert.deepStrictEqual(days(await load(september())), ['9021:2026-09-02']);
    assert.deepStrictEqual(
      days(await load(september({ includeUnmonitored: true }))),
      [
        '9021:2026-09-02',
        '9022:2026-09-02',
        '9023:2026-09-02',
        '9024:2026-09-02',
      ]
    );
    assert.deepStrictEqual(readIds(fake), [[21], [21, 22, 23, 24]]);
  });

  it('skips a source manga that no longer matches its binding without a partial notice', async () => {
    const moved = fakeDispatchManga(31, {
      chapters: [uploaded(3101, 1, '2026-09-02T00:00:00.000Z')],
    });
    const renumbered = fakeDispatchManga(32, {
      chapters: [uploaded(3201, 1, '2026-09-03T00:00:00.000Z')],
    });
    const fake = await start(1, [moved, renumbered]);
    await request(moved, 9031);
    await request(renumbered, 9032, { suwayomiMangaId: 99 });
    fake.manga(31).url = fakeMangaUrl('moved');

    const result = await load(september());

    assert.deepStrictEqual(result.results, [
      entry(9032, '2026-09-03', 1, false),
    ]);
    assert.deepStrictEqual(result.partialSources, []);
    assert.deepStrictEqual(readIds(fake), [[31, 32, 99]]);
    assert.deepStrictEqual(
      logsOf(
        logs,
        'A bound manga no longer matches its Suwayomi entry; its chapter releases are skipped.'
      ),
      [
        [
          'debug',
          { label: 'Release Calendar', instanceId: 1, suwayomiMangaId: 99 },
        ],
        [
          'debug',
          { label: 'Release Calendar', instanceId: 1, suwayomiMangaId: 31 },
        ],
      ]
    );
  });

  it('reports an unreadable instance as partial, keeps the others and reads it again next time', async () => {
    const working = fakeDispatchManga(41, {
      chapters: [uploaded(4101, 1, '2026-09-02T00:00:00.000Z')],
    });
    const failing = fakeDispatchManga(42, {
      chapters: [uploaded(4201, 1, '2026-09-04T00:00:00.000Z')],
    });
    const workingFake = await start(1, [working]);
    const failingFake = await start(2, [failing]);
    await request(working, 9041);
    await request(failing, 9042, { instanceId: 2 });
    failingFake.server.onOperation(
      'ChapterReleases',
      graphqlErrors([syntheticFailure()])
    );

    const admin = await load(september());
    assert.deepStrictEqual(days(admin), ['9041:2026-09-02']);
    assert.deepStrictEqual(admin.partialSources, [
      { source: 'suwayomi', serverId: 2 },
    ]);
    assert.strictEqual(admin.truncated, false);
    const [failure] = logsOf(logs, 'Manga chapter releases could not be read.');
    assert.strictEqual(failure?.[0], 'debug');
    assert.deepStrictEqual(Object.keys(failure[1]), [
      'label',
      'instanceId',
      'code',
    ]);
    assert.strictEqual(failure[1].instanceId, 2);

    const user = await load(september(), { isAdmin: false });
    assert.deepStrictEqual(user.partialSources, [{ source: 'suwayomi' }]);

    serveFakeChapterReleases(failingFake);
    const recovered = await load(september());
    assert.deepStrictEqual(days(recovered), [
      '9041:2026-09-02',
      '9042:2026-09-04',
    ]);
    assert.deepStrictEqual(recovered.partialSources, []);
    assert.strictEqual(reads(workingFake).length, 1);
    assert.strictEqual(reads(failingFake).length, 3);
  });

  it('names titles through AniList and leaves out what the content policy or AniList leaves out', async () => {
    const mangas = [51, 52, 53, 54].map((id) =>
      fakeDispatchManga(id, {
        chapters: [uploaded(id * 100 + 1, 1, `2026-09-0${id - 50}T00:00:00Z`)],
      })
    );
    await start(1, mangas);
    for (const [index, manga] of mangas.entries())
      await request(manga, 9051 + index);
    catalog.set(9051, summary(9051, { isAdult: true }));
    catalog.set(9052, summary(9052, { format: 'NOVEL' }));
    catalog.set(9053, null);
    catalog.set(9054, summary(9054, { titles: { romaji: 'Calendar Romaji' } }));

    const strict = await load(september());
    assert.deepStrictEqual(strict.results, [
      { ...entry(9054, '2026-09-04', 1, false), title: 'Calendar Romaji' },
    ]);
    assert.deepStrictEqual(anilistCalls, [[9051, 9052, 9053, 9054]]);

    settings.main.mangaIncludeAdult = true;
    settings.main.mangaIncludeNovels = true;
    assert.deepStrictEqual(days(await load(september())), [
      '9051:2026-09-01',
      '9052:2026-09-02',
      '9054:2026-09-04',
    ]);
  });

  it('reports an AniList failure as partial and leaves its titles out', async () => {
    const manga = fakeDispatchManga(55, {
      chapters: [uploaded(5501, 1, '2026-09-02T00:00:00.000Z')],
    });
    await start(1, [manga]);
    await request(manga, 9055);
    catalog.set(9055, new Error('unavailable'));

    assert.deepStrictEqual(await load(september()), {
      results: [],
      partialSources: [{ source: 'anilist' }],
      truncated: false,
    });
    assert.deepStrictEqual(
      logsOf(logs, 'Manga titles for the release calendar could not be read.'),
      [['debug', { label: 'Release Calendar', titles: 1, errorName: 'Error' }]]
    );
  });

  it('pages through both lists and stops at the page budget', async () => {
    const manga = fakeDispatchManga(61, {
      chapters: [1, 2, 3, 4, 5].map((number) =>
        uploaded(6100 + number, number, `2026-09-0${number}T00:00:00.000Z`)
      ),
    });
    const fake = await start(1, [manga], 2);
    await request(manga, 9061);

    const budget = await load(september(), { limits: { pages: 2 } });
    assert.strictEqual(budget.truncated, true);
    assert.deepStrictEqual(days(budget), [
      '9061:2026-09-01',
      '9061:2026-09-02',
      '9061:2026-09-03',
      '9061:2026-09-04',
    ]);
    assert.strictEqual(reads(fake).length, 2);

    resetMangaReleaseCalendarCache();
    const complete = await load(september(), { limits: { pages: 3 } });
    assert.strictEqual(complete.truncated, false);
    assert.strictEqual(complete.results.length, 5);
    assert.deepStrictEqual(
      reads(fake)
        .slice(2)
        .map(({ variables }) => [
          variables.uploadedAfter,
          variables.undatedAfter,
        ]),
      [
        [null, null],
        ['6102', null],
        ['6104', null],
      ]
    );
  });

  it('keeps to the request, library, instance, title and entry limits', async () => {
    const mangas = [71, 72, 73, 74].map((id) =>
      fakeDispatchManga(id, {
        inLibrary: true,
        chapters: [
          uploaded(id * 100 + 1, 1, `2026-09-0${id - 70}T00:00:00.000Z`),
          uploaded(id * 100 + 2, 2, `2026-09-1${id - 70}T00:00:00.000Z`),
        ],
      })
    );
    const fake = await start(1, mangas.slice(0, 3));
    const otherFake = await start(2, mangas.slice(3));
    const older = await request(mangas[0], 9071);
    await request(mangas[3], 9074, { instanceId: 2 });
    const newer = await request(mangas[1], 9072);
    await seedDispatchBinding(mangas[2], { anilistId: 9073 });

    const requests = await load(september(), { limits: { requests: 1 } });
    assert.strictEqual(requests.truncated, true);
    assert.deepStrictEqual(days(requests), [
      '9072:2026-09-02',
      '9072:2026-09-12',
    ]);
    assert.deepStrictEqual(readIds(fake), [[72]]);
    assert.deepStrictEqual(reads(otherFake), []);

    const firstInstance = await load(september(), {
      limits: { instances: 1 },
    });
    assert.strictEqual(firstInstance.truncated, true);
    assert.deepStrictEqual(readIds(fake), [[72], [71, 72]]);
    assert.deepStrictEqual(reads(otherFake), []);

    const personal = await load(september({ scope: 'mine' }), {
      requests: [newer.request, older.request],
      limits: { requests: 1 },
    });
    assert.strictEqual(personal.truncated, true);
    assert.deepStrictEqual(days(personal), [
      '9072:2026-09-02',
      '9072:2026-09-12',
    ]);

    resetMangaReleaseCalendarCache();
    const library = await load(september({ includeUnmonitored: true }), {
      limits: { libraryTitles: 0 },
    });
    assert.strictEqual(library.truncated, true);
    assert.ok(!days(library).some((day) => day.startsWith('9073:')));

    resetMangaReleaseCalendarCache();
    const titles = await load(september({ includeUnmonitored: true }), {
      limits: { titles: 2 },
    });
    assert.strictEqual(titles.truncated, true);
    assert.deepStrictEqual(anilistCalls.at(-1), [9071, 9072]);
    assert.deepStrictEqual(days(titles), [
      '9071:2026-09-01',
      '9072:2026-09-02',
      '9071:2026-09-11',
      '9072:2026-09-12',
    ]);

    const events = await load(september({ includeUnmonitored: true }), {
      limits: { events: 3 },
    });
    assert.strictEqual(events.truncated, true);
    assert.strictEqual(events.results.length, 3);

    const untruncated = await load(september({ includeUnmonitored: true }));
    assert.strictEqual(untruncated.truncated, false);
    assert.strictEqual(untruncated.results.length, 8);
  });

  it('names titles in AniList batches of at most 50', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => 100 + index);
    const mangas = ids.map((id) =>
      fakeDispatchManga(id, {
        inLibrary: true,
        chapters: [uploaded(id * 100 + 1, 1, '2026-09-02T00:00:00.000Z')],
      })
    );
    const fake = await start(1, mangas);
    for (const manga of mangas)
      await seedDispatchBinding(manga, { anilistId: 20_000 + manga.id });

    const result = await load(september({ includeUnmonitored: true }));

    assert.strictEqual(result.results.length, 51);
    assert.deepStrictEqual(
      anilistCalls.map((batch) => batch.length),
      [50, 1]
    );
    assert.deepStrictEqual(anilistCalls[1], [20_150]);
    assert.deepStrictEqual(readIds(fake), [ids]);
  });

  it('shares one read while it is fresh and reads again after a minute or a reset', async () => {
    const manga = fakeDispatchManga(81, {
      chapters: [
        uploaded(8101, 1, '2026-08-20T00:00:00.000Z'),
        uploaded(8102, 2, '2026-09-02T00:00:00.000Z'),
      ],
    });
    const fake = await start(1, [manga]);
    await request(manga, 9081);

    await load(september());
    await load(september(), { isAdmin: false });
    assert.strictEqual(reads(fake).length, 1);

    await Promise.all([load(august()), load(august())]);
    assert.strictEqual(reads(fake).length, 2);

    await load(september(), { now: new Date(NOW.getTime() + 61_000) });
    assert.strictEqual(reads(fake).length, 3);

    resetMangaReleaseCalendarCache();
    await load(august());
    assert.strictEqual(reads(fake).length, 4);
  });

  it('keeps the cache within its row and entry bounds', async () => {
    const manga = fakeDispatchManga(82, {
      chapters: [
        ...[1, 2, 3].map((number) =>
          uploaded(8200 + number, number, `2026-08-1${number}T00:00:00.000Z`)
        ),
        ...[4, 5, 6].map((number) =>
          uploaded(8200 + number, number, `2026-09-1${number}T00:00:00.000Z`)
        ),
      ],
    });
    const fake = await start(1, [manga]);
    await request(manga, 9082);
    const count = () => reads(fake).length;

    // Each window holds the title's key and three chapter numbers.
    await load(september(), { limits: { cacheRows: 3 } });
    await load(september(), { limits: { cacheRows: 3 } });
    assert.strictEqual(count(), 2);

    resetMangaReleaseCalendarCache();
    const rows = { limits: { cacheRows: 5 } };
    await load(september(), rows);
    await load(september(), rows);
    assert.strictEqual(count(), 3);
    await load(august(), rows);
    await load(august(), rows);
    assert.strictEqual(count(), 4);
    await load(september(), rows);
    assert.strictEqual(count(), 5);

    resetMangaReleaseCalendarCache();
    const entries = { limits: { cacheEntries: 1 } };
    await load(september(), entries);
    await load(august(), entries);
    await load(august(), entries);
    assert.strictEqual(count(), 7);
    await load(september(), entries);
    assert.strictEqual(count(), 8);
  });
});
