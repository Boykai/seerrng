import AnilistAPI from '@server/api/anilist';
import type { AnilistMangaDetails } from '@server/api/anilist/manga';
import SuwayomiAPI from '@server/api/suwayomi';
import { SuwayomiError } from '@server/api/suwayomi/errors';
import { MangaRequestBindingState } from '@server/constants/mangaRequest';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import MangaRequestManifest from '@server/entity/MangaRequestManifest';
import MangaSourceBinding, {
  MangaBindingState,
  hashMangaSourceUrl,
} from '@server/entity/MangaSourceBinding';
import {
  MANGA_DOWNLOAD_STREAMS_PER_INSTANCE,
  MANGA_DOWNLOAD_STREAMS_PER_USER,
  MangaDownloadLimitError,
  acquireMangaDownloadSlot,
  countMangaDownloadSlots,
  getMangaDownloadErrorFields,
  guardMangaDownload,
  loadMangaDownloadCopies,
  openMangaDownloadCopy,
  type MangaDownloadCopy,
} from '@server/lib/mangaDownloadCopy';
import type { SuwayomiSettings } from '@server/lib/settings';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  FAKE_SOURCE_ID,
  dispatchInstanceFor,
  fakeChapterUrl,
  fakeDispatchManga,
  fakeMangaUrl,
  type FakeDispatchChapter,
  type FakeDispatchManga,
} from '@server/test/fakeSuwayomiDispatch';
import {
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import {
  DOWNLOAD_TITLE,
  archiveGets,
  archivePath,
  archiveReply,
  assertPrivateLogs,
  captureLogs,
  deliver,
  downloadedManga,
  seedDeliveredRequest,
  serveArchive,
  type CapturedLog,
} from '@server/test/mangaDownloadCopies';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';

setupTestDb();

const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const includeAdult = settings.main.mangaIncludeAdult;
const fakes: FakeProgressSuwayomi[] = [];
let catalog: Map<number, AnilistMangaDetails | null | Error>;
let anilistCalls: number[];
let logs: CapturedLog[] = [];

const configure = (...instances: SuwayomiSettings[]) => {
  invalidateSuwayomiClients();
  settings.suwayomi = instances;
};

const details = (
  anilistId: number,
  overrides: Partial<AnilistMangaDetails> = {}
): AnilistMangaDetails => ({
  id: anilistId,
  titles: { english: DOWNLOAD_TITLE },
  synonyms: [],
  format: 'MANGA',
  isAdult: false,
  genres: [],
  tags: [],
  staff: [],
  ...overrides,
});

/** A fake serving `mangas` as instance 1, the only configured instance. */
const start = async (...mangas: FakeDispatchManga[]) => {
  const fake = await startFakeProgressSuwayomi(mangas);
  fakes.push(fake);
  configure(dispatchInstanceFor(fake.server));
  return fake;
};

const chapter = (
  mangaId: number,
  id: number,
  chapterNumber: number,
  suffix = ''
): FakeDispatchChapter => ({
  id,
  url: `${fakeChapterUrl(mangaId, chapterNumber)}${suffix}`,
  chapterNumber,
  isDownloaded: true,
});

const namesOf = async (requestId: number) =>
  (await loadMangaDownloadCopies({ id: requestId })).map(({ name }) => name);

const copyOf = async (requestId: number, chapterUrl: string) => {
  const copy = (await loadMangaDownloadCopies({ id: requestId })).find(
    ({ urlHash }) => urlHash === hashMangaSourceUrl(chapterUrl)
  );
  assert.ok(copy, 'The chapter is not listed');
  return copy;
};

const readAll = async (stream: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  settings.main.mangaIncludeAdult = false;
  configure();
  logs = captureLogs();
  catalog = new Map();
  anilistCalls = [];
  mock.method(
    AnilistAPI.prototype,
    'getMangaDetails',
    async (anilistId: number) => {
      anilistCalls.push(anilistId);
      const entry = catalog.get(anilistId);
      if (entry instanceof Error) throw entry;
      return entry === undefined ? details(anilistId) : entry;
    }
  );
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    assertPrivateLogs(logs);
    assert.deepStrictEqual(countMangaDownloadSlots(), {
      users: 0,
      instances: 0,
    });
  } finally {
    mock.restoreAll();
    mock.timers.reset();
    settings.main.enabledMediaCategories = categories;
    settings.main.mangaIncludeAdult = includeAdult;
    configure();
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('manga download copy listing', () => {
  it('names each verified chapter after the request title, newest first and unknown numbers last', async () => {
    const manga = fakeDispatchManga(11, {
      inLibrary: true,
      chapters: [
        chapter(11, 1101, 1),
        chapter(11, 1102, 2),
        chapter(11, 1103, 10.5),
        chapter(11, 1104, 2, '-alt'),
        chapter(11, 1105, -1, '-extra'),
        chapter(11, 1106, 3),
        chapter(11, 1107, 0),
      ],
    });
    const fake = await start(manga);
    const { request } = await seedDeliveredRequest(manga);

    const copies = await loadMangaDownloadCopies(request);

    assert.deepStrictEqual(
      copies.map(({ name }) => name),
      [
        'Sample Manga - Ch. 10.5.cbz',
        'Sample Manga - Ch. 3.cbz',
        'Sample Manga - Ch. 2.cbz',
        'Sample Manga - Ch. 2 (2).cbz',
        'Sample Manga - Ch. 1.cbz',
        'Sample Manga - Ch. 0.cbz',
        'Sample Manga - Ch. unknown.cbz',
      ]
    );
    assert.deepStrictEqual(
      copies.map(({ urlHash }) => urlHash),
      [1103, 1106, 1102, 1104, 1101, 1107, 1105].map((id) =>
        hashMangaSourceUrl(
          manga.chapters.find((entry) => entry.id === id)?.url ?? ''
        )
      )
    );
    assert.deepStrictEqual(copies[0].manga, {
      sourceId: FAKE_SOURCE_ID,
      url: manga.url,
      urlHash: hashMangaSourceUrl(manga.url),
    });
    assert.deepStrictEqual(anilistCalls, [9001]);
    // Listing never contacts Suwayomi.
    assert.strictEqual(fake.server.requests.length, 0);
  });

  it('lists only rows the poll verified and still finds, and a row once it is verified', async () => {
    const manga = downloadedManga(11, [1, 2, 3]);
    await start(manga);
    const { request, rows } = await seedDeliveredRequest(manga, {
      delivered: false,
    });
    assert.deepStrictEqual(await namesOf(request.id), []);
    // Nothing verified: the title is not even looked up.
    assert.deepStrictEqual(anilistCalls, []);

    await deliver([rows[0], rows[2]]);
    await getRepository(MangaRequestChapter).update(rows[2].id, {
      missingSince: new Date(),
    });
    assert.deepStrictEqual(await namesOf(request.id), [
      'Sample Manga - Ch. 1.cbz',
    ]);

    await deliver([rows[1]]);
    assert.deepStrictEqual(await namesOf(request.id), [
      'Sample Manga - Ch. 2.cbz',
      'Sample Manga - Ch. 1.cbz',
    ]);
  });

  it("never lists another request's chapters of the same title", async () => {
    const manga = downloadedManga(11, [1, 2, 3]);
    await start(manga);
    const first = await seedDeliveredRequest(manga, { numbers: [1, 2] });
    const second = await seedDeliveredRequest(manga, {
      numbers: [3],
      binding: null,
      media: first.media,
    });

    assert.deepStrictEqual(await namesOf(first.request.id), [
      'Sample Manga - Ch. 2.cbz',
      'Sample Manga - Ch. 1.cbz',
    ]);
    assert.deepStrictEqual(await namesOf(second.request.id), [
      'Sample Manga - Ch. 3.cbz',
    ]);
  });

  it('falls back to the AniList ID when the title cannot be shown', async () => {
    const manga = downloadedManga(11, [1]);
    await start(manga);
    const { request } = await seedDeliveredRequest(manga);
    const fallback = ['Manga 9001 - Ch. 1.cbz'];

    for (const entry of [
      new Error('AniList is unavailable'),
      null,
      details(9001, { isAdult: true }),
      details(9001, { titles: { english: ' \u0007 ' } }),
      details(9001, { titles: {} }),
    ]) {
      catalog.set(9001, entry);
      assert.deepStrictEqual(await namesOf(request.id), fallback);
    }

    settings.main.mangaIncludeAdult = true;
    catalog.set(9001, details(9001, { isAdult: true }));
    assert.deepStrictEqual(await namesOf(request.id), [
      'Sample Manga - Ch. 1.cbz',
    ]);
  });

  it('uses the English, then romaji, then native title, cleaned and shortened', async () => {
    const manga = downloadedManga(11, [1]);
    await start(manga);
    const { request } = await seedDeliveredRequest(manga);
    const cases: [AnilistMangaDetails['titles'], string][] = [
      [{ romaji: 'Romaji Title', native: 'N' }, 'Romaji Title'],
      [{ native: 'Native Title' }, 'Native Title'],
      [{ english: 'Line\nBreak\tand\u0007Bell ' }, 'Line Break and Bell'],
      [{ english: 'A'.repeat(300) }, 'A'.repeat(200)],
      // Never half a character, which no file name can encode.
      [{ english: `${'A'.repeat(199)}\u{1F600} tail` }, 'A'.repeat(199)],
      [
        { english: `${'A'.repeat(198)}\u{1F600} tail` },
        `${'A'.repeat(198)}\u{1F600}`,
      ],
      [{ english: 'Lone\ud800Half' }, 'Lone Half'],
    ];

    for (const [titles, expected] of cases) {
      catalog.set(9001, details(9001, { titles }));
      const names = await namesOf(request.id);
      assert.deepStrictEqual(names, [`${expected} - Ch. 1.cbz`]);
      assert.doesNotThrow(() => encodeURIComponent(names[0]));
    }
  });

  it('lists nothing unless manga is on, the request is bound, its server serves CBZ and the match is active', async () => {
    const manga = downloadedManga(11, [1]);
    const fake = await start(manga);
    const { request, manifest } = await seedDeliveredRequest(manga);
    const binding = await getRepository(MangaSourceBinding).findOneByOrFail({
      anilistId: 9001,
    });
    assert.strictEqual((await namesOf(request.id)).length, 1);
    anilistCalls = [];

    const checks: [string, () => unknown, () => unknown][] = [
      [
        'manga off',
        () => {
          settings.main.enabledMediaCategories = {
            ...categories,
            manga: false,
          };
        },
        () => {
          settings.main.enabledMediaCategories = {
            ...categories,
            manga: true,
          };
        },
      ],
      [
        'not bound',
        () =>
          getRepository(MangaRequestManifest).update(manifest.id, {
            bindingState: MangaRequestBindingState.AWAITING_BINDING,
          }),
        () =>
          getRepository(MangaRequestManifest).update(manifest.id, {
            bindingState: MangaRequestBindingState.BOUND,
          }),
      ],
      [
        'match orphaned',
        () =>
          getRepository(MangaSourceBinding).update(binding.id, {
            state: MangaBindingState.ORPHANED,
          }),
        () =>
          getRepository(MangaSourceBinding).update(binding.id, {
            state: MangaBindingState.ACTIVE,
          }),
      ],
      [
        'server removed',
        () => configure(),
        () => configure(dispatchInstanceFor(fake.server)),
      ],
      [
        'CBZ not required',
        () =>
          configure(dispatchInstanceFor(fake.server, 1, { requireCbz: false })),
        () => configure(dispatchInstanceFor(fake.server)),
      ],
    ];

    for (const [label, apply, undo] of checks) {
      await apply();
      assert.deepStrictEqual(await namesOf(request.id), [], label);
      await undo();
    }
    assert.deepStrictEqual(anilistCalls, []);
    assert.strictEqual((await namesOf(request.id)).length, 1);
    assert.strictEqual(fake.server.requests.length, 0);
  });
});

describe('opening a manga download copy', () => {
  it('resolves the manga by its natural key and streams the chapter archive, never by a stored ID', async () => {
    const manga = downloadedManga(11, [1, 2]);
    const fake = await start(manga);
    // A backup restore renumbered the manga: the stored IDs are stale.
    const { request } = await seedDeliveredRequest(manga, {
      binding: { suwayomiMangaId: 77 },
      manifest: { suwayomiMangaId: 77 },
    });
    serveArchive(fake, 1102, archiveReply('chapter two'));
    const copy = await copyOf(request.id, fakeChapterUrl(11, 2));

    const opened = await openMangaDownloadCopy(
      copy,
      new AbortController().signal
    );

    assert.ok(opened);
    assert.strictEqual(opened.contentLength, 11);
    assert.strictEqual(await readAll(opened.stream), 'chapter two');
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'DownloadedChapters',
    ]);
    const [lookup] = fake.server.operations('ByNaturalKey');
    assert.deepStrictEqual(
      [String(lookup.variables.sourceId), lookup.variables.url],
      [FAKE_SOURCE_ID, manga.url]
    );
    const [chapters] = fake.server.operations('DownloadedChapters');
    assert.strictEqual(String(chapters.variables.mangaId), '11');
    // The archive path carries no query: Suwayomi marks nothing read.
    assert.deepStrictEqual(
      archiveGets(fake).map(({ url }) => url),
      [archivePath(1102)]
    );
    assert.deepStrictEqual(fake.headIds(), []);
  });

  it('opens nothing when the manga found is not the bound one', async () => {
    const manga = downloadedManga(11, [1]);
    const fake = await start(manga);
    const { request } = await seedDeliveredRequest(manga);
    const copy = await copyOf(request.id, fakeChapterUrl(11, 1));
    const find = SuwayomiAPI.prototype.findMangaByNaturalKey;

    for (const change of [
      { sourceId: '2002' },
      { url: fakeMangaUrl('other') },
    ]) {
      const swapped = mock.method(
        SuwayomiAPI.prototype,
        'findMangaByNaturalKey',
        async function (
          this: SuwayomiAPI,
          ...args: Parameters<SuwayomiAPI['findMangaByNaturalKey']>
        ) {
          const found = await find.apply(this, args);
          return found && { ...found, ...change };
        }
      );
      assert.strictEqual(
        await openMangaDownloadCopy(copy, new AbortController().signal),
        undefined
      );
      swapped.mock.restore();
    }
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'ByNaturalKey',
    ]);
    assert.deepStrictEqual(archiveGets(fake), []);
  });

  it('opens nothing when Suwayomi no longer has the manga or the downloaded chapter', async () => {
    const manga = downloadedManga(11, [1, 2]);
    const fake = await start(manga);
    const { request } = await seedDeliveredRequest(manga);
    const one = await copyOf(request.id, fakeChapterUrl(11, 1));
    const two = await copyOf(request.id, fakeChapterUrl(11, 2));
    const signal = new AbortController().signal;

    manga.chapters[0].isDownloaded = false;
    assert.strictEqual(await openMangaDownloadCopy(one, signal), undefined);

    // A downloaded chapter with the same URL on another manga is not this one.
    const getChapters = SuwayomiAPI.prototype.getDownloadedChapters;
    const elsewhere = mock.method(
      SuwayomiAPI.prototype,
      'getDownloadedChapters',
      async function (
        this: SuwayomiAPI,
        ...args: Parameters<SuwayomiAPI['getDownloadedChapters']>
      ) {
        const chapters = await getChapters.apply(this, args);
        return chapters.map((entry) => ({ ...entry, mangaId: '12' }));
      }
    );
    assert.strictEqual(await openMangaDownloadCopy(two, signal), undefined);
    elsewhere.mock.restore();

    fake.state.mangas = [];
    assert.strictEqual(await openMangaDownloadCopy(two, signal), undefined);
    assert.deepStrictEqual(fake.operationNames(), [
      'ByNaturalKey',
      'DownloadedChapters',
      'ByNaturalKey',
      'DownloadedChapters',
      'ByNaturalKey',
    ]);
    assert.deepStrictEqual(archiveGets(fake), []);

    const removed: MangaDownloadCopy = { ...two, instanceId: 2 };
    assert.strictEqual(await openMangaDownloadCopy(removed, signal), undefined);
  });

  it('stops before Suwayomi when the browser already left', async () => {
    const manga = downloadedManga(11, [1]);
    const fake = await start(manga);
    const { request } = await seedDeliveredRequest(manga);
    const copy = await copyOf(request.id, fakeChapterUrl(11, 1));

    await assert.rejects(
      openMangaDownloadCopy(copy, AbortSignal.abort()),
      (error) => error instanceof SuwayomiError && error.code === 'ABORTED'
    );
    assert.deepStrictEqual(fake.server.requests, []);
  });
});

describe('manga download slots', () => {
  it('lets each user run two downloads and each server four', () => {
    assert.strictEqual(MANGA_DOWNLOAD_STREAMS_PER_USER, 2);
    assert.strictEqual(MANGA_DOWNLOAD_STREAMS_PER_INSTANCE, 4);
    const held = [
      acquireMangaDownloadSlot(1, 1),
      acquireMangaDownloadSlot(1, 1),
    ];
    assert.strictEqual(acquireMangaDownloadSlot(1, 1), undefined);
    assert.strictEqual(acquireMangaDownloadSlot(1, 2), undefined);
    held.push(acquireMangaDownloadSlot(2, 1), acquireMangaDownloadSlot(2, 1));
    assert.strictEqual(acquireMangaDownloadSlot(3, 1), undefined);
    const other = acquireMangaDownloadSlot(3, 2);
    assert.ok(other);
    assert.deepStrictEqual(countMangaDownloadSlots(), {
      users: 5,
      instances: 5,
    });

    for (const release of [...held, other]) {
      assert.ok(release);
      release();
    }
    assert.deepStrictEqual(countMangaDownloadSlots(), {
      users: 0,
      instances: 0,
    });
  });

  it('frees a slot once however often it is released', () => {
    const first = acquireMangaDownloadSlot(1, 1);
    const second = acquireMangaDownloadSlot(1, 1);
    assert.ok(first && second);
    first();
    first();
    assert.deepStrictEqual(countMangaDownloadSlots(), {
      users: 1,
      instances: 1,
    });
    const third = acquireMangaDownloadSlot(1, 1);
    assert.ok(third);
    assert.strictEqual(acquireMangaDownloadSlot(1, 1), undefined);
    second();
    third();
    assert.deepStrictEqual(countMangaDownloadSlots(), {
      users: 0,
      instances: 0,
    });
  });
});

describe('manga download guard', () => {
  const guarded = (stallMs: number, totalMs: number) => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const source = new PassThrough();
    const target = new PassThrough();
    const errors: unknown[] = [];
    source.on('error', (error) => errors.push(error));
    const guard = guardMangaDownload(source, target, { stallMs, totalMs });
    return { source, target, errors, guard };
  };

  const codesOf = (errors: unknown[]) =>
    errors.map((error) =>
      error instanceof MangaDownloadLimitError ? error.code : String(error)
    );

  it('stops a download whose client accepts nothing for the stall time', async () => {
    const { source, target, errors, guard } = guarded(1_000, 10_000);
    await flush();

    mock.timers.tick(999);
    await flush();
    assert.strictEqual(source.destroyed, false);

    mock.timers.tick(1);
    await flush();
    assert.strictEqual(source.destroyed, true);
    assert.strictEqual(target.destroyed, true);
    assert.deepStrictEqual(codesOf(errors), ['STALLED']);
    assert.strictEqual(guard.stopped?.code, 'STALLED');
  });

  it('restarts the stall time whenever data flows', async () => {
    const { source, errors, guard } = guarded(1_000, 10_000);
    await flush();

    for (let step = 0; step < 4; step += 1) {
      mock.timers.tick(800);
      source.write('chunk');
      await flush();
    }
    mock.timers.tick(999);
    await flush();
    assert.strictEqual(source.destroyed, false);
    assert.strictEqual(guard.stopped, undefined);

    mock.timers.tick(1);
    await flush();
    assert.deepStrictEqual(codesOf(errors), ['STALLED']);
  });

  it('stops a download that runs past the total time, however steadily it flows', async () => {
    const { source, target, errors, guard } = guarded(1_000, 2_500);
    await flush();

    for (let step = 0; step < 3; step += 1) {
      mock.timers.tick(800);
      source.write('chunk');
      await flush();
    }
    assert.strictEqual(source.destroyed, false);

    mock.timers.tick(100);
    await flush();
    assert.strictEqual(source.destroyed, true);
    assert.strictEqual(target.destroyed, true);
    assert.deepStrictEqual(codesOf(errors), ['TOTAL_TIME']);
    assert.strictEqual(guard.stopped?.code, 'TOTAL_TIME');
  });

  it('ends a download whose client stops reading after Suwayomi finished sending', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const source = Readable.from([Buffer.from('archive')], {
      objectMode: false,
    });
    // A client that never takes the last bytes: the response cannot finish.
    const target = new Writable({ write: () => undefined });
    const guard = guardMangaDownload(source, target, {
      stallMs: 1_000,
      totalMs: 10_000,
    });
    const piped = pipeline(source, target);
    let settled = false;
    piped.then(
      () => (settled = true),
      () => (settled = true)
    );
    await flush();
    await flush();
    assert.strictEqual(source.destroyed, true);

    mock.timers.tick(999);
    await flush();
    assert.strictEqual(settled, false);

    mock.timers.tick(1);
    await assert.rejects(piped);
    assert.strictEqual(target.destroyed, true);
    assert.strictEqual(guard.stopped?.code, 'STALLED');
  });

  it('leaves a response alone once it finished', async () => {
    const { source, target, errors, guard } = guarded(1_000, 2_000);
    target.end();
    await flush();
    assert.strictEqual(target.writableFinished, true);

    mock.timers.tick(5_000);
    await flush();
    assert.strictEqual(source.destroyed, false);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(guard.stopped, undefined);
    guard.dispose();
    source.destroy();
  });

  it('does nothing once disposed', async () => {
    const { source, target, errors, guard } = guarded(1_000, 2_000);
    await flush();
    guard.dispose();
    assert.strictEqual(source.listenerCount('data'), 0);

    mock.timers.tick(5_000);
    await flush();
    assert.strictEqual(source.destroyed, false);
    assert.strictEqual(target.destroyed, false);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(guard.stopped, undefined);
    source.destroy();
    target.destroy();
  });
});

describe('manga download log fields', () => {
  it('keeps codes and names and drops every message', () => {
    assert.deepStrictEqual(
      getMangaDownloadErrorFields(
        new SuwayomiError('HTTP_ERROR', 'ChapterArchive', { httpStatus: 503 })
      ),
      { code: 'HTTP_ERROR', operation: 'ChapterArchive', httpStatus: 503 }
    );
    assert.deepStrictEqual(
      getMangaDownloadErrorFields(new MangaDownloadLimitError('STALLED')),
      { code: 'STALLED' }
    );
    assert.deepStrictEqual(
      getMangaDownloadErrorFields(new TypeError(`${DOWNLOAD_TITLE} failed`)),
      { errorName: 'TypeError' }
    );
    assert.deepStrictEqual(getMangaDownloadErrorFields('failed'), {
      errorName: 'string',
    });
  });
});
