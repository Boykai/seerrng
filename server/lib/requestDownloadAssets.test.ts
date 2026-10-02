import { MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  listRequestDownloadAssets,
  openRequestDownloadAsset,
  openVerifiedMappedFile,
} from './requestDownloadAssets';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
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

it('lists and opens no local copies for manga requests', async () => {
  // Linked service fields prove manga does not reach a book or comic provider.
  const request = {
    id: 1,
    type: MediaType.MANGA,
    is4k: false,
    media: {
      id: 2,
      mediaType: MediaType.MANGA,
      serviceId: 3,
      externalServiceId: 4,
      comicServiceType: 'mylar',
    },
  } as unknown as MediaRequest;

  await expect(listRequestDownloadAssets(request)).resolves.toEqual([]);
  await expect(
    openRequestDownloadAsset(request, 'a'.repeat(43))
  ).resolves.toBeUndefined();
});
