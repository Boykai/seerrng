import AnilistAPI from '@server/api/anilist';
import * as datasource from '@server/datasource';
import { getRepository } from '@server/datasource';
import MangaRequestChapter from '@server/entity/MangaRequestChapter';
import { hashMangaSourceUrl } from '@server/entity/MangaSourceBinding';
import {
  findMangaDownloadAsset,
  listRequestDownloadAssets,
  openRequestDownloadAsset,
} from '@server/lib/requestDownloadAssets';
import { getSettings } from '@server/lib/settings';
import { invalidateSuwayomiClients } from '@server/lib/suwayomi/clientFactory';
import { setupTestDb } from '@server/test/db';
import {
  dispatchInstanceFor,
  fakeChapterUrl,
} from '@server/test/fakeSuwayomiDispatch';
import {
  startFakeProgressSuwayomi,
  type FakeProgressSuwayomi,
} from '@server/test/fakeSuwayomiProgress';
import {
  DOWNLOAD_TITLE,
  assertPrivateLogs,
  captureLogs,
  downloadedManga,
  logsOf,
  seedDeliveredRequest,
  type CapturedLog,
} from '@server/test/mangaDownloadCopies';
import { waitForBackgroundTasks } from '@server/utils/backgroundTasks';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

const settings = getSettings();
const categories = settings.main.enabledMediaCategories;
const fakes: FakeProgressSuwayomi[] = [];
let logs: CapturedLog[] = [];

const ASSET_ID = /^[A-Za-z0-9_-]{43}$/;

const start = async (id = 11, numbers: readonly number[] = [1, 2]) => {
  const fake = await startFakeProgressSuwayomi([downloadedManga(id, numbers)]);
  fakes.push(fake);
  invalidateSuwayomiClients();
  settings.suwayomi = [dispatchInstanceFor(fake.server)];
  return { fake, manga: fake.manga(id) };
};

/** Verified rows for chapters `numbers` of manga 11, written directly. */
const addDeliveredRows = async (
  manifestId: number,
  numbers: readonly number[]
) => {
  const rows = numbers.map((chapterNumber) => {
    const url = fakeChapterUrl(11, chapterNumber);
    return new MangaRequestChapter({
      manifestId,
      url,
      urlHash: hashMangaSourceUrl(url),
      chapterNumber,
      deliverableAt: new Date(),
    });
  });
  await getRepository(MangaRequestChapter).save(rows, { chunk: 200 });
};

beforeEach(() => {
  settings.main.enabledMediaCategories = { ...categories, manga: true };
  logs = captureLogs();
  mock.method(AnilistAPI.prototype, 'getMangaDetails', async (id: number) => ({
    id,
    titles: { english: DOWNLOAD_TITLE },
    synonyms: [],
    isAdult: false,
    genres: [],
    tags: [],
    staff: [],
  }));
});

afterEach(async () => {
  try {
    await waitForBackgroundTasks();
    assertPrivateLogs(logs);
  } finally {
    mock.restoreAll();
    settings.main.enabledMediaCategories = categories;
    invalidateSuwayomiClients();
    settings.suwayomi = [];
    await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  }
});

describe('manga request download assets', () => {
  it('lists each verified chapter under a stable, request-scoped ID and no size', async () => {
    const { fake, manga } = await start();
    const first = await seedDeliveredRequest(manga);
    const second = await seedDeliveredRequest(manga, {
      binding: null,
      media: first.media,
    });

    const listed = await listRequestDownloadAssets(first.request);

    assert.deepStrictEqual(
      listed.map(({ name }) => name),
      ['Sample Manga - Ch. 2.cbz', 'Sample Manga - Ch. 1.cbz']
    );
    for (const asset of listed) {
      assert.match(asset.id, ASSET_ID);
      // Suwayomi is not asked for sizes: listing never contacts it.
      assert.strictEqual(asset.size, undefined);
    }
    assert.notStrictEqual(listed[0].id, listed[1].id);
    assert.deepStrictEqual(
      await listRequestDownloadAssets(first.request),
      listed
    );

    // The same chapters of another request carry other IDs.
    const other = await listRequestDownloadAssets(second.request);
    assert.deepStrictEqual(
      other.map(({ name }) => name),
      listed.map(({ name }) => name)
    );
    for (const asset of other) {
      assert.ok(!listed.some(({ id }) => id === asset.id));
      assert.strictEqual(
        await findMangaDownloadAsset(first.request, asset.id),
        undefined
      );
    }
    assert.strictEqual(fake.server.requests.length, 0);
  });

  it('finds the chapter an ID names, and nothing for an unknown or malformed ID', async () => {
    const { manga } = await start();
    const { request } = await seedDeliveredRequest(manga);
    const [newest] = await listRequestDownloadAssets(request);

    const found = await findMangaDownloadAsset(request, newest.id);

    assert.ok(found);
    assert.strictEqual(found.name, 'Sample Manga - Ch. 2.cbz');
    assert.strictEqual(
      found.urlHash,
      hashMangaSourceUrl(fakeChapterUrl(11, 2))
    );
    for (const assetId of [
      'A'.repeat(43),
      `${newest.id.slice(0, 42)}+`,
      newest.id.slice(1),
      `${newest.id}A`,
      '',
    ]) {
      assert.strictEqual(
        await findMangaDownloadAsset(request, assetId),
        undefined
      );
    }
  });

  it('lists at most 1,000 chapters yet still finds the one left out', async () => {
    const { manga } = await start(11, [1]);
    const { request, manifest } = await seedDeliveredRequest(manga);
    await addDeliveredRows(
      manifest.id,
      Array.from({ length: 999 }, (_, index) => index + 2)
    );
    const full = await listRequestDownloadAssets(request);
    assert.strictEqual(full.length, 1_000);
    const oldest = full[full.length - 1];
    assert.strictEqual(oldest.name, 'Sample Manga - Ch. 1.cbz');

    await addDeliveredRows(manifest.id, [1_001]);
    const capped = await listRequestDownloadAssets(request);

    assert.strictEqual(capped.length, 1_000);
    assert.strictEqual(capped[0].name, 'Sample Manga - Ch. 1001.cbz');
    assert.strictEqual(capped[999].name, 'Sample Manga - Ch. 2.cbz');
    assert.ok(!capped.some(({ id }) => id === oldest.id));
    assert.strictEqual(
      (await findMangaDownloadAsset(request, oldest.id))?.name,
      'Sample Manga - Ch. 1.cbz'
    );
  });

  it('ignores comic service fields on manga media', async () => {
    const { manga } = await start();
    const { request } = await seedDeliveredRequest(manga);
    Object.assign(request.media, {
      comicServiceType: 'mylar',
      serviceId: 1,
      externalServiceId: 5,
    });

    assert.deepStrictEqual(
      (await listRequestDownloadAssets(request)).map(({ name }) => name),
      ['Sample Manga - Ch. 2.cbz', 'Sample Manga - Ch. 1.cbz']
    );
  });

  it('never opens a manga chapter through the local-file path', async () => {
    const { fake, manga } = await start();
    const { request } = await seedDeliveredRequest(manga);
    const [asset] = await listRequestDownloadAssets(request);

    assert.strictEqual(
      await openRequestDownloadAsset(request, asset.id),
      undefined
    );
    assert.strictEqual(fake.server.requests.length, 0);
  });

  it('lists nothing and logs codes only when the chapters cannot be read', async () => {
    const { manga } = await start();
    const { request } = await seedDeliveredRequest(manga);
    mock.method(datasource, 'getRepository', () => {
      throw new Error(`${DOWNLOAD_TITLE} at ${manga.url}`);
    });

    assert.deepStrictEqual(await listRequestDownloadAssets(request), []);
    assert.deepStrictEqual(
      logsOf(logs, 'Unable to list manga download copies'),
      [
        [
          'warn',
          {
            label: 'Request Downloads',
            requestId: request.id,
            errorName: 'Error',
          },
        ],
      ]
    );
    assert.deepStrictEqual(
      logsOf(logs, 'Unable to list local request download copies'),
      []
    );
  });
});
