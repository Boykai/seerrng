import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import AnilistAPI from '@server/api/anilist';
import { AnilistOutageError } from '@server/api/anilist/failures';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import MangaRequestManifest, {
  MangaRequestBindingState,
  MangaRequestCheckpoint,
  MangaRequestScope,
} from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingConfidence,
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import {
  DEFAULT_MANGA_REQUEST_SCOPE,
  MANGA_REQUEST_CHECKPOINTS,
  MAX_MANGA_CHAPTER_NUMBER,
  MAX_MANGA_LATEST_COUNT,
  MangaCatalogUnavailableError,
  MangaRequestNotFoundError,
  advanceMangaRequestCheckpoint,
  assertMangaRequestable,
  buildMangaRequestChapterRows,
  getNextMangaRequestCheckpoint,
  loadMangaRequestScopeSummaries,
  parseMangaRequestId,
  parseMangaRequestScope,
  selectMangaManifestChapters,
  selectMangaRequestInstance,
  updateMangaRequestManifest,
  type MangaChapterCandidate,
} from '@server/lib/mangaRequests';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

afterEach(() => {
  mock.restoreAll();
});

const { ALL_AT_DISPATCH, LATEST_N, RANGE } = MangaRequestScope;

const scopeError = (input: unknown): string => {
  const parsed = parseMangaRequestScope(input);
  assert.ok(
    'error' in parsed,
    `expected an error for ${JSON.stringify(input)}`
  );
  return parsed.error;
};

const scopeValue = (input: unknown) => {
  const parsed = parseMangaRequestScope(input);
  assert.ok('value' in parsed, `expected a value for ${JSON.stringify(input)}`);
  return parsed.value;
};

/** A manga request with a manifest, written directly. */
const seedManifest = async (
  anilistId: number,
  overrides: Partial<MangaRequestManifest> = {}
): Promise<MangaRequestManifest> => {
  const requestedBy = await getRepository(User).findOneByOrFail({ id: 2 });
  const media = await getRepository(Media).save(
    new Media({
      tmdbId: 0,
      mediaType: MediaType.MANGA,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    })
  );
  const request = await getRepository(MediaRequest).save(
    new MediaRequest({
      type: MediaType.MANGA,
      status: MediaRequestStatus.PENDING,
      media,
      requestedBy,
      is4k: false,
      serverId: overrides.instanceId ?? 1,
    })
  );
  return getRepository(MangaRequestManifest).save(
    new MangaRequestManifest({
      requestId: request.id,
      anilistId,
      instanceId: 1,
      ...DEFAULT_MANGA_REQUEST_SCOPE,
      ...overrides,
    })
  );
};

const seedBinding = (
  anilistId: number,
  instanceId: number,
  state = MangaBindingState.ACTIVE
) =>
  getRepository(MangaSourceBinding).save(
    new MangaSourceBinding({
      instanceId,
      sourceId: '1000',
      url: `/manga/${anilistId}-${instanceId}`,
      urlHash: hashMangaSourceUrl(`/manga/${anilistId}-${instanceId}`),
      anilistId,
      suwayomiMangaId: 1,
      title: 'Sample Manga',
      confidence: MangaBindingConfidence.TRACKER_LINK,
      matchedBy: 'anilist-tracker',
      origin: 'library-scan',
      state,
      inLibrary: state === MangaBindingState.ACTIVE,
    })
  );

const details = (
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id: 900001,
  titles: { english: 'Sample Manga' },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  ...overrides,
});

describe('parseMangaRequestScope', () => {
  it('defaults to every chapter at dispatch', () => {
    for (const input of [undefined, null, {}, { scope: ALL_AT_DISPATCH }]) {
      assert.deepStrictEqual(scopeValue(input), DEFAULT_MANGA_REQUEST_SCOPE);
    }
    assert.deepStrictEqual(
      scopeValue({
        scope: ALL_AT_DISPATCH,
        latestCount: null,
        rangeStart: null,
        rangeEnd: null,
      }),
      DEFAULT_MANGA_REQUEST_SCOPE
    );
  });

  it('accepts a bounded positive LATEST_N count', () => {
    for (const latestCount of [1, 25, MAX_MANGA_LATEST_COUNT]) {
      assert.deepStrictEqual(scopeValue({ scope: LATEST_N, latestCount }), {
        scope: LATEST_N,
        latestCount,
        rangeStart: null,
        rangeEnd: null,
      });
    }
  });

  it('refuses a LATEST_N count that is not a bounded positive integer', () => {
    for (const latestCount of [
      undefined,
      null,
      0,
      -1,
      1.5,
      '5',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_MANGA_LATEST_COUNT + 1,
    ]) {
      assert.match(
        scopeError({ scope: LATEST_N, latestCount }),
        /latestCount must be an integer/
      );
    }
    assert.match(
      scopeError({ scope: LATEST_N, latestCount: 5, rangeStart: 1 }),
      /LATEST_N takes latestCount only/
    );
  });

  it('accepts finite inclusive ranges, open-ended without an end', () => {
    assert.deepStrictEqual(
      scopeValue({ scope: RANGE, rangeStart: 1, rangeEnd: 10.5 }),
      { scope: RANGE, latestCount: null, rangeStart: 1, rangeEnd: 10.5 }
    );
    assert.deepStrictEqual(
      scopeValue({ scope: RANGE, rangeStart: 0, rangeEnd: 0 }),
      { scope: RANGE, latestCount: null, rangeStart: 0, rangeEnd: 0 }
    );
    assert.deepStrictEqual(
      scopeValue({ scope: RANGE, rangeStart: 12, rangeEnd: null }),
      { scope: RANGE, latestCount: null, rangeStart: 12, rangeEnd: null }
    );
  });

  it('refuses a range without a finite start or with its end before its start', () => {
    for (const rangeStart of [
      undefined,
      null,
      -1,
      '1',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_MANGA_CHAPTER_NUMBER + 1,
    ]) {
      assert.match(
        scopeError({ scope: RANGE, rangeStart, rangeEnd: 10 }),
        /rangeStart must be a chapter number/
      );
    }
    for (const rangeEnd of [
      4,
      -1,
      '10',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_MANGA_CHAPTER_NUMBER + 1,
    ]) {
      assert.match(
        scopeError({ scope: RANGE, rangeStart: 5, rangeEnd }),
        /rangeEnd must be a chapter number/
      );
    }
    assert.match(
      scopeError({ scope: RANGE, rangeStart: 1, latestCount: 3 }),
      /RANGE takes rangeStart and rangeEnd only/
    );
  });

  it('refuses unknown scopes, unknown fields and limits on ALL_AT_DISPATCH', () => {
    assert.match(scopeError('LATEST_N'), /must be an object/);
    assert.match(scopeError([LATEST_N]), /must be an object/);
    assert.match(scopeError({ scope: 'EVERYTHING' }), /mangaScope.scope must/);
    assert.match(
      scopeError({ scope: LATEST_N, latestCount: 1, chapters: [1] }),
      /unsupported field/
    );
    assert.match(
      scopeError({ latestCount: 5 }),
      /ALL_AT_DISPATCH takes no chapter limits/
    );
  });

  it('parses its own output to the same value', () => {
    for (const input of [
      undefined,
      { scope: LATEST_N, latestCount: 3 },
      { scope: RANGE, rangeStart: 2, rangeEnd: 8 },
      { scope: RANGE, rangeStart: 2 },
    ]) {
      const value = scopeValue(input);
      assert.deepStrictEqual(scopeValue(value), value);
    }
  });
});

describe('parseMangaRequestId', () => {
  it('accepts positive integer AniList IDs only', () => {
    assert.strictEqual(parseMangaRequestId(900001), 900001);
    assert.strictEqual(parseMangaRequestId('900001'), 900001);
    assert.strictEqual(parseMangaRequestId(' 900001 '), 900001);
    for (const value of [0, -1, 1.5, 'abc', '', null, undefined, {}]) {
      assert.strictEqual(parseMangaRequestId(value), undefined);
    }
  });
});

describe('manga request checkpoints', () => {
  it('lists the seven dispatch steps in order', () => {
    assert.deepStrictEqual(MANGA_REQUEST_CHECKPOINTS, [
      MangaRequestCheckpoint.BINDING_VERIFIED,
      MangaRequestCheckpoint.INSTANCE_MARKED,
      MangaRequestCheckpoint.LIBRARY_ADDED,
      MangaRequestCheckpoint.CATEGORY_READY,
      MangaRequestCheckpoint.CHAPTERS_FETCHED,
      MangaRequestCheckpoint.MANIFEST_FROZEN,
      MangaRequestCheckpoint.CHAPTERS_ENQUEUED,
    ]);
    assert.strictEqual(
      getNextMangaRequestCheckpoint(null),
      MangaRequestCheckpoint.BINDING_VERIFIED
    );
    assert.strictEqual(
      getNextMangaRequestCheckpoint(MangaRequestCheckpoint.CHAPTERS_FETCHED),
      MangaRequestCheckpoint.MANIFEST_FROZEN
    );
    assert.strictEqual(
      getNextMangaRequestCheckpoint(MangaRequestCheckpoint.CHAPTERS_ENQUEUED),
      undefined
    );
  });

  it('advances one step at a time from the expected step only', async () => {
    const manifest = await seedManifest(900001);
    const read = () =>
      getRepository(MangaRequestManifest).findOneByOrFail({ id: manifest.id });

    assert.strictEqual(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        null
      ),
      true
    );
    // A second worker expecting the same step loses.
    assert.strictEqual(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        null
      ),
      false
    );
    assert.strictEqual(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        MangaRequestCheckpoint.LIBRARY_ADDED
      ),
      false
    );
    const first = await read();
    assert.strictEqual(
      first.checkpoint,
      MangaRequestCheckpoint.BINDING_VERIFIED
    );
    assert.ok(first.checkpointAt instanceof Date);
    assert.strictEqual(first.frozenAt, null);

    let current: MangaRequestCheckpoint | null = first.checkpoint;
    while (current !== MangaRequestCheckpoint.CHAPTERS_FETCHED) {
      assert.ok(
        await advanceMangaRequestCheckpoint(
          dataSource.manager,
          manifest.id,
          current
        )
      );
      current = (await read()).checkpoint;
    }
    assert.strictEqual((await read()).frozenAt, null);
    assert.ok(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        current
      )
    );
    const frozen = await read();
    assert.strictEqual(
      frozen.checkpoint,
      MangaRequestCheckpoint.MANIFEST_FROZEN
    );
    assert.ok(frozen.frozenAt instanceof Date);
    assert.ok(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        MangaRequestCheckpoint.MANIFEST_FROZEN
      )
    );
    assert.strictEqual(
      await advanceMangaRequestCheckpoint(
        dataSource.manager,
        manifest.id,
        MangaRequestCheckpoint.CHAPTERS_ENQUEUED
      ),
      false
    );
  });
});

describe('selectMangaManifestChapters', () => {
  const chapter = (
    url: string,
    chapterNumber: number | null,
    extra: Partial<MangaChapterCandidate> = {}
  ): MangaChapterCandidate => ({ url, chapterNumber, ...extra });
  const urls = (chapters: MangaChapterCandidate[]) =>
    chapters.map(({ url }) => url);
  const chapters = [
    chapter('/c/3', 3),
    chapter('/c/1', 1),
    chapter('/c/x', null),
    chapter('/c/2', 2),
    chapter('/c/minus', -1),
    chapter('/c/2.5', 2.5),
  ];

  it('keeps every chapter at dispatch, known numbers first in order', () => {
    assert.deepStrictEqual(
      urls(selectMangaManifestChapters(DEFAULT_MANGA_REQUEST_SCOPE, chapters)),
      ['/c/1', '/c/2', '/c/2.5', '/c/3', '/c/x', '/c/minus']
    );
  });

  it('keeps the N highest distinct numbers for LATEST_N', () => {
    const scope = { ...DEFAULT_MANGA_REQUEST_SCOPE, scope: LATEST_N };
    assert.deepStrictEqual(
      urls(selectMangaManifestChapters({ ...scope, latestCount: 2 }, chapters)),
      ['/c/2.5', '/c/3']
    );
    assert.deepStrictEqual(
      urls(
        selectMangaManifestChapters({ ...scope, latestCount: 50 }, chapters)
      ),
      ['/c/1', '/c/2', '/c/2.5', '/c/3']
    );
  });

  it('keeps an inclusive range, open-ended without an end', () => {
    const scope = { ...DEFAULT_MANGA_REQUEST_SCOPE, scope: RANGE };
    assert.deepStrictEqual(
      urls(
        selectMangaManifestChapters(
          { ...scope, rangeStart: 2, rangeEnd: 2.5 },
          chapters
        )
      ),
      ['/c/2', '/c/2.5']
    );
    assert.deepStrictEqual(
      urls(
        selectMangaManifestChapters({ ...scope, rangeStart: 2.5 }, chapters)
      ),
      ['/c/2.5', '/c/3']
    );
  });

  it('keeps one chapter per number by scanlator preference, upload and URL', () => {
    const duplicates = [
      chapter('/a', 1, { scanlator: 'Group B', uploadDate: 300 }),
      chapter('/b', 1, { scanlator: ' group a ', uploadDate: 100 }),
      chapter('/c', 2, { scanlator: 'Group C', uploadDate: 100 }),
      chapter('/d', 2, { scanlator: 'Group D', uploadDate: 200 }),
      chapter('/f', 3, { uploadDate: 100 }),
      chapter('/e', 3, { uploadDate: 100 }),
    ];
    assert.deepStrictEqual(
      urls(
        selectMangaManifestChapters(DEFAULT_MANGA_REQUEST_SCOPE, duplicates, [
          'Group A',
          'Group B',
        ])
      ),
      ['/b', '/d', '/e']
    );
  });

  it('lists each URL once', () => {
    assert.deepStrictEqual(
      urls(
        selectMangaManifestChapters(DEFAULT_MANGA_REQUEST_SCOPE, [
          chapter('/same', null),
          chapter('/same', null),
        ])
      ),
      ['/same']
    );
  });
});

describe('buildMangaRequestChapterRows', () => {
  it('keys rows by URL hash and skips unusable URLs', () => {
    const rows = buildMangaRequestChapterRows(7, [
      { url: '/c/1', chapterNumber: 1, scanlator: '  Group A  ' },
      { url: '/c/1', chapterNumber: 1 },
      { url: '/c/x', chapterNumber: -1, scanlator: '   ' },
      { url: '', chapterNumber: 2 },
      { url: `/${'x'.repeat(2048)}`, chapterNumber: 3 },
      {
        url: '/c/4',
        chapterNumber: 4,
        scanlator: `${'s'.repeat(254)}\u{1F600}`,
      },
    ]);

    assert.deepStrictEqual(
      rows.map(({ manifestId, url, urlHash, chapterNumber, scanlator }) => ({
        manifestId,
        url,
        urlHash,
        chapterNumber,
        scanlator,
      })),
      [
        {
          manifestId: 7,
          url: '/c/1',
          urlHash: hashMangaSourceUrl('/c/1'),
          chapterNumber: 1,
          scanlator: 'Group A',
        },
        {
          manifestId: 7,
          url: '/c/x',
          urlHash: hashMangaSourceUrl('/c/x'),
          chapterNumber: null,
          scanlator: null,
        },
        {
          manifestId: 7,
          url: '/c/4',
          urlHash: hashMangaSourceUrl('/c/4'),
          chapterNumber: 4,
          // Cut at 255 UTF-16 units without leaving half a surrogate pair.
          scanlator: 's'.repeat(254),
        },
      ]
    );
  });
});

describe('selectMangaRequestInstance', () => {
  const instance = (id: number, isDefault = false) =>
    ({ id, isDefault }) as SuwayomiSettings;

  it('picks the given instance, else the default, else the first', () => {
    const instances = [instance(1), instance(2, true), instance(3)];
    assert.strictEqual(selectMangaRequestInstance(instances, 3)?.id, 3);
    assert.strictEqual(selectMangaRequestInstance(instances, 9), undefined);
    assert.strictEqual(selectMangaRequestInstance(instances)?.id, 2);
    assert.strictEqual(selectMangaRequestInstance(instances, null)?.id, 2);
    assert.strictEqual(
      selectMangaRequestInstance([instance(4), instance(5)])?.id,
      4
    );
    assert.strictEqual(selectMangaRequestInstance([]), undefined);
  });
});

describe('assertMangaRequestable', () => {
  it('refuses unknown, adult and novel titles alike', async (t) => {
    const settings = getSettings();
    const { mangaIncludeAdult, mangaIncludeNovels } = settings.main;
    t.after(() => {
      settings.main.mangaIncludeAdult = mangaIncludeAdult;
      settings.main.mangaIncludeNovels = mangaIncludeNovels;
    });
    settings.main.mangaIncludeAdult = false;
    settings.main.mangaIncludeNovels = false;
    let current: AnilistMangaDetails | null = null;
    const getDetails = mock.method(
      AnilistAPI.prototype,
      'getMangaDetails',
      async () => current
    );

    for (const next of [
      null,
      details({ isAdult: true }),
      details({ format: 'NOVEL' }),
    ]) {
      current = next;
      await assert.rejects(
        () => assertMangaRequestable(900001),
        (error: unknown) =>
          error instanceof MangaRequestNotFoundError &&
          error.message === 'Manga not found.'
      );
    }

    current = details({ format: 'ONE_SHOT' });
    await assertMangaRequestable(900001);
    settings.main.mangaIncludeAdult = true;
    current = details({ isAdult: true });
    await assertMangaRequestable(900001);
    settings.main.mangaIncludeNovels = true;
    current = details({ format: 'NOVEL' });
    await assertMangaRequestable(900001);
    assert.ok(
      getDetails.mock.calls.every(({ arguments: [id] }) => id === 900001)
    );
  });

  it('reports an AniList failure as the catalog being unavailable', async () => {
    const failure = new AnilistOutageError('AniList is unavailable.');
    mock.method(AnilistAPI.prototype, 'getMangaDetails', async () => {
      throw failure;
    });

    await assert.rejects(
      () => assertMangaRequestable(900001),
      (error: unknown) =>
        error instanceof MangaCatalogUnavailableError &&
        error.failure === failure
    );
  });
});

describe('updateMangaRequestManifest', () => {
  it('moves an unfrozen manifest and recomputes its binding state', async () => {
    await seedBinding(900001, 2);
    const manifest = await seedManifest(900001);
    const scope = {
      scope: LATEST_N,
      latestCount: 5,
      rangeStart: null,
      rangeEnd: null,
    };

    assert.strictEqual(
      await updateMangaRequestManifest(dataSource.manager, manifest.requestId, {
        instanceId: 2,
        scope,
      }),
      true
    );
    const moved = await getRepository(MangaRequestManifest).findOneByOrFail({
      id: manifest.id,
    });
    assert.strictEqual(moved.instanceId, 2);
    assert.strictEqual(moved.scope, LATEST_N);
    assert.strictEqual(moved.latestCount, 5);
    assert.strictEqual(moved.bindingState, MangaRequestBindingState.BOUND);
    assert.ok(moved.boundAt instanceof Date);

    // An edit without a scope keeps the scope.
    assert.ok(
      await updateMangaRequestManifest(dataSource.manager, manifest.requestId, {
        instanceId: 1,
      })
    );
    const back = await getRepository(MangaRequestManifest).findOneByOrFail({
      id: manifest.id,
    });
    assert.strictEqual(back.instanceId, 1);
    assert.strictEqual(back.latestCount, 5);
    assert.strictEqual(
      back.bindingState,
      MangaRequestBindingState.AWAITING_BINDING
    );
    assert.strictEqual(back.boundAt, null);
  });

  it('refuses a frozen or missing manifest', async () => {
    const manifest = await seedManifest(900001, { frozenAt: new Date() });

    assert.strictEqual(
      await updateMangaRequestManifest(dataSource.manager, manifest.requestId, {
        instanceId: 2,
        scope: {
          ...DEFAULT_MANGA_REQUEST_SCOPE,
          scope: LATEST_N,
          latestCount: 1,
        },
      }),
      false
    );
    assert.strictEqual(
      await updateMangaRequestManifest(dataSource.manager, 999_999, {
        instanceId: 2,
      }),
      false
    );
    const unchanged = await getRepository(MangaRequestManifest).findOneByOrFail(
      {
        id: manifest.id,
      }
    );
    assert.strictEqual(unchanged.instanceId, 1);
    assert.strictEqual(unchanged.scope, ALL_AT_DISPATCH);
  });
});

describe('loadMangaRequestScopeSummaries', () => {
  it('summarizes the scope and the parked state by request ID', async () => {
    const parked = await seedManifest(900001, {
      scope: RANGE,
      rangeStart: 1,
      rangeEnd: 9.5,
    });
    const bound = await seedManifest(900002, {
      bindingState: MangaRequestBindingState.BOUND,
      boundAt: new Date(),
    });

    const summaries = await loadMangaRequestScopeSummaries(dataSource.manager, [
      parked.requestId,
      bound.requestId,
      parked.requestId,
      999_999,
    ]);

    assert.deepStrictEqual(Object.fromEntries(summaries), {
      [parked.requestId]: {
        scope: RANGE,
        latestCount: null,
        rangeStart: 1,
        rangeEnd: 9.5,
        awaitingBinding: true,
      },
      [bound.requestId]: {
        scope: ALL_AT_DISPATCH,
        latestCount: null,
        rangeStart: null,
        rangeEnd: null,
        awaitingBinding: false,
      },
    });
  });
});
