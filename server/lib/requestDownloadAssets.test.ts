import type { MediaRequest } from '@server/entity/MediaRequest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const readarrMockState = vi.hoisted(() => ({
  runtimeConfig: undefined as unknown,
  bookFiles: new Map<number, { bookId: number; path: string }[]>(),
  unavailableBookIds: new Set<number>(),
  backIssueSeries: new Map<number, { id: number; files: { path: string }[] }>(),
  lazyLibrarianIssues: new Map<string, { issues: { issueFile: string }[] }>(),
}));

vi.mock('@server/api/servarr/readarr', () => ({
  default: class MockReadarrAPI {
    constructor() {}

    static buildUrl() {
      return 'http://readarr.test/api/v1';
    }

    async getBookFiles(bookId: number) {
      if (readarrMockState.unavailableBookIds.has(bookId)) {
        throw new Error('Readarr is unavailable');
      }
      return readarrMockState.bookFiles.get(bookId) ?? [];
    }
  },
}));

vi.mock('@server/api/comics/backissue', () => ({
  default: class MockBackIssueAPI {
    constructor() {}

    static buildUrl() {
      return 'http://backissue.test/api';
    }

    async getSeries(seriesId: number) {
      return readarrMockState.backIssueSeries.get(seriesId);
    }
  },
}));

vi.mock('@server/api/lazylibrarian', () => ({
  default: class MockLazyLibrarianAPI {
    constructor() {}

    static buildUrl() {
      return 'http://lazylibrarian.test';
    }

    async getIssues(title: string) {
      return readarrMockState.lazyLibrarianIssues.get(title) ?? { issues: [] };
    }
  },
}));

vi.mock('@server/lib/externalRuntimeConfig', () => ({
  getExternalRuntimeConfig: () => readarrMockState.runtimeConfig,
}));

import {
  listRequestDownloadAssets,
  openVerifiedMappedFile,
} from './requestDownloadAssets';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  readarrMockState.runtimeConfig = undefined;
  readarrMockState.bookFiles.clear();
  readarrMockState.unavailableBookIds.clear();
  readarrMockState.backIssueSeries.clear();
  readarrMockState.lazyLibrarianIssues.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

it('keeps ebook and audiobook file formats distinct for combined requests', async () => {
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'library');
  await mkdir(root);
  await writeFile(path.join(root, 'book.epub'), 'ebook');
  await writeFile(path.join(root, 'book.m4b'), 'audiobook');
  readarrMockState.runtimeConfig = {
    main: {
      apiKey: 'test-download-key',
      downloadPathMappings: [
        {
          serviceType: 'readarr',
          remoteRoot: '/remote/library',
          localRoot: root,
        },
      ],
    },
    readarr: [{ id: 1, url: 'http://readarr.test', apiKey: 'test-api-key' }],
  };
  readarrMockState.bookFiles.set(101, [
    { bookId: 101, path: '/remote/library/book.epub' },
  ]);
  readarrMockState.bookFiles.set(202, [
    { bookId: 202, path: '/remote/library/book.m4b' },
  ]);

  const request = {
    id: 42,
    type: 'book',
    bookFormat: 'both',
    serviceTargets: [
      {
        serviceType: 'readarr',
        format: 'ebook',
        serverId: 1,
        externalServiceId: 101,
      },
      {
        serviceType: 'readarr',
        format: 'audiobook',
        serverId: 1,
        externalServiceId: 202,
      },
    ],
    media: {},
  } as unknown as MediaRequest;

  const assets = await listRequestDownloadAssets(request);

  expect(assets.results.map(({ format, name }) => ({ format, name }))).toEqual([
    { format: 'ebook', name: 'book.epub' },
    { format: 'audiobook', name: 'book.m4b' },
  ]);
  expect(assets.hadErrors).toBe(false);
});

it('keeps an available format when its combined request partner is unavailable', async () => {
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'library');
  await mkdir(root);
  await writeFile(path.join(root, 'book.m4b'), 'audiobook');
  readarrMockState.runtimeConfig = {
    main: {
      apiKey: 'test-download-key',
      downloadPathMappings: [
        {
          serviceType: 'readarr',
          remoteRoot: '/remote/library',
          localRoot: root,
        },
      ],
    },
    readarr: [{ id: 1, url: 'http://readarr.test', apiKey: 'test-api-key' }],
  };
  readarrMockState.bookFiles.set(202, [
    { bookId: 202, path: '/remote/library/book.m4b' },
  ]);
  readarrMockState.unavailableBookIds.add(101);

  const result = await listRequestDownloadAssets({
    id: 43,
    type: 'book',
    bookFormat: 'both',
    serviceTargets: [
      {
        serviceType: 'readarr',
        format: 'ebook',
        serverId: 1,
        externalServiceId: 101,
      },
      {
        serviceType: 'readarr',
        format: 'audiobook',
        serverId: 1,
        externalServiceId: 202,
      },
    ],
    media: {},
  } as unknown as MediaRequest);

  expect(result.results.map(({ format, name }) => ({ format, name }))).toEqual([
    { format: 'audiobook', name: 'book.m4b' },
  ]);
  expect(result.hadErrors).toBe(true);
});

it('resolves comic issue files through a mapped BackIssue library path', async () => {
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'comics');
  await mkdir(root);
  await writeFile(path.join(root, 'series-01.cbz'), 'comic issue');
  readarrMockState.runtimeConfig = {
    main: {
      apiKey: 'test-download-key',
      downloadPathMappings: [
        {
          serviceType: 'backissue',
          remoteRoot: '/remote/comics',
          localRoot: root,
        },
      ],
    },
    backissue: [
      { id: 3, url: 'http://backissue.test', apiKey: 'test-api-key' },
    ],
  };
  readarrMockState.backIssueSeries.set(77, {
    id: 77,
    files: [{ path: '/remote/comics/series-01.cbz' }],
  });

  const assets = await listRequestDownloadAssets({
    id: 19,
    type: 'comic',
    media: {
      comicServiceType: 'backissue',
      serviceId: 3,
      externalServiceId: 77,
    },
  } as unknown as MediaRequest);

  expect(assets.results.map(({ name }) => name)).toEqual(['series-01.cbz']);
  expect(assets.hadErrors).toBe(false);
});

it('resolves magazine issue PDFs through a mapped LazyLibrarian library path', async () => {
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'magazines');
  await mkdir(root);
  await writeFile(path.join(root, 'monthly-2026-10.pdf'), 'magazine issue');
  readarrMockState.runtimeConfig = {
    main: {
      apiKey: 'test-download-key',
      downloadPathMappings: [
        {
          serviceType: 'lazylibrarian',
          remoteRoot: '/remote/magazines',
          localRoot: root,
        },
      ],
    },
    lazylibrarian: [
      {
        id: 4,
        url: 'http://lazylibrarian.test',
        apiKey: 'test-api-key',
      },
    ],
  };
  readarrMockState.lazyLibrarianIssues.set('Reader Monthly', {
    issues: [{ issueFile: '/remote/magazines/monthly-2026-10.pdf' }],
  });

  const assets = await listRequestDownloadAssets({
    id: 20,
    type: 'magazine',
    media: {
      serviceId: 4,
      externalServiceSlug: 'Reader Monthly',
    },
  } as unknown as MediaRequest);

  expect(assets.results.map(({ name }) => name)).toEqual([
    'monthly-2026-10.pdf',
  ]);
  expect(assets.hadErrors).toBe(false);
});

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'seerrng-request-download-')
  );
  temporaryDirectories.push(directory);
  return directory;
};

it('opens a regular file that remains within its configured root', async () => {
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'library');
  const filePath = path.join(root, 'book.epub');
  await mkdir(root);
  await writeFile(filePath, 'ebook');

  const opened = await openVerifiedMappedFile(filePath, root);
  expect(opened?.size).toBe(5);
  try {
    expect(await opened?.file.readFile('utf8')).toBe('ebook');
  } finally {
    await opened?.file.close();
  }
});

it('rejects a parent symlink that redirects a mapped file outside its root', async () => {
  if (process.platform === 'win32') return;
  const directory = await createTemporaryDirectory();
  const root = path.join(directory, 'library');
  const outside = path.join(directory, 'outside');
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'private');
  await symlink(outside, path.join(root, 'linked'), 'dir');

  await expect(
    openVerifiedMappedFile(path.join(root, 'linked', 'secret.txt'), root)
  ).resolves.toBeUndefined();
});
