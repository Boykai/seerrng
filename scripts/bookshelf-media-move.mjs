#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_PREVIEW_FILE_BYTES = 1024 * 1024;

export const usage = `BookshelfNG media path migration (administrator API key required)

Preview a batch (preview is the default and never starts a move):
  pnpm bookshelf:move -- --service-id 1 --format ebook \\
    --destination-root /books/new --author-id 42 --preview-file /tmp/books.json

Apply only that saved preview (requires explicit confirmation):
  pnpm bookshelf:move -- --apply --preview-file /tmp/books.json --yes

Check a queued command:
  pnpm bookshelf:move -- --service-id 1 --status 123

Environment:
  SEERRNG_URL       SeerrNG base URL, for example https://media.example.com
  SEERRNG_API_KEY   SeerrNG administrator API key (not the Bookshelf API key)

Repeat --author-id to include multiple authors. A batch supports at most 1,000.
The saved preview file contains a batch-specific move authorization token; keep it
private and remove it after applying. Moves run inside one Bookshelf database.`;

const valueAfter = (args, index, option) => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
};

export const parseArgs = (args) => {
  const parsed = {
    authorIds: [],
    apply: false,
    yes: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--help' || option === '-h') {
      parsed.help = true;
    } else if (option === '--apply') {
      parsed.apply = true;
    } else if (option === '--yes') {
      parsed.yes = true;
    } else if (
      [
        '--service-id',
        '--format',
        '--destination-root',
        '--source-root',
        '--author-id',
        '--preview-file',
        '--status',
      ].includes(option)
    ) {
      const value = valueAfter(args, index, option);
      index += 1;
      if (option === '--author-id') parsed.authorIds.push(value);
      else if (option === '--service-id') parsed.serviceId = value;
      else if (option === '--format') parsed.format = value;
      else if (option === '--destination-root')
        parsed.destinationRootPath = value;
      else if (option === '--source-root') parsed.sourceRootPath = value;
      else if (option === '--preview-file') parsed.previewFile = value;
      else if (option === '--status') parsed.statusId = value;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  if (parsed.help) return parsed;
  if (parsed.yes && !parsed.apply) {
    throw new Error('--yes is only valid with --apply.');
  }

  if (parsed.apply) {
    if (!parsed.yes || !parsed.previewFile) {
      throw new Error('--apply requires both --preview-file and --yes.');
    }
    if (
      parsed.serviceId ||
      parsed.format ||
      parsed.destinationRootPath ||
      parsed.sourceRootPath ||
      parsed.authorIds.length ||
      parsed.statusId
    ) {
      throw new Error(
        '--apply uses the saved preview details; do not pass move options.'
      );
    }
    return parsed;
  }

  if (parsed.statusId) {
    if (
      !parsed.serviceId ||
      !/^\d+$/.test(parsed.serviceId) ||
      Number(parsed.serviceId) < 1 ||
      parsed.authorIds.length ||
      parsed.format ||
      parsed.destinationRootPath ||
      parsed.sourceRootPath ||
      parsed.previewFile
    ) {
      throw new Error(
        '--status requires --service-id and cannot be combined with preview options.'
      );
    }
    if (!/^\d+$/.test(parsed.statusId) || Number(parsed.statusId) < 1) {
      throw new Error('--status must be a positive command ID.');
    }
    return parsed;
  }

  if (
    !parsed.serviceId ||
    !/^\d+$/.test(parsed.serviceId) ||
    Number(parsed.serviceId) < 1
  ) {
    throw new Error('--service-id must be a positive Bookshelf service ID.');
  }
  if (!['ebook', 'audiobook'].includes(parsed.format)) {
    throw new Error('--format must be ebook or audiobook.');
  }
  if (!parsed.destinationRootPath?.trim()) {
    throw new Error('--destination-root is required.');
  }
  if (!parsed.authorIds.length || parsed.authorIds.length > 1000) {
    throw new Error('Provide between 1 and 1,000 --author-id values.');
  }
  if (
    parsed.authorIds.some((id) => !/^\d+$/.test(id) || Number(id) < 1) ||
    new Set(parsed.authorIds).size !== parsed.authorIds.length
  ) {
    throw new Error('--author-id values must be unique positive integers.');
  }
  if (
    parsed.destinationRootPath.length > 4096 ||
    /[\0-\x1f\x7f]/.test(parsed.destinationRootPath)
  ) {
    throw new Error('--destination-root must be a valid Bookshelf path.');
  }
  if (
    parsed.sourceRootPath &&
    (parsed.sourceRootPath.length > 4096 ||
      /[\0-\x1f\x7f]/.test(parsed.sourceRootPath))
  ) {
    throw new Error('--source-root must be a valid Bookshelf path.');
  }
  return parsed;
};

export const normalizeServerBase = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SEERRNG_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'SEERRNG_URL must be an HTTP(S) base URL without credentials, query, or fragment.'
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

const getApiCredentials = (env) => {
  if (!env.SEERRNG_URL || !env.SEERRNG_API_KEY) {
    throw new Error(
      'Set SEERRNG_URL and SEERRNG_API_KEY before running this command.'
    );
  }
  return {
    serverBase: normalizeServerBase(env.SEERRNG_URL),
    apiKey: env.SEERRNG_API_KEY,
  };
};

const apiRequest = async ({ serverBase, apiKey }, method, path, body) => {
  const response = await fetch(`${serverBase}/api/v1${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'X-Api-Key': apiKey,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error('SeerrNG returned an unexpectedly large response.');
  }
  const chunks = [];
  let responseBytes = 0;
  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      responseBytes += value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error('SeerrNG returned an unexpectedly large response.');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const text = Buffer.concat(chunks, responseBytes).toString('utf8');
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      `SeerrNG returned a non-JSON response (HTTP ${response.status}).`
    );
  }
  if (!response.ok) {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : `HTTP ${response.status}`;
    throw new Error(`SeerrNG request failed: ${message}`);
  }
  return { status: response.status, data };
};

const validatePreviewFileHandle = (stats) => {
  if (!stats.isFile() || stats.nlink !== 1)
    throw new Error('Preview file must be a regular file, not a symlink.');
  if (stats.size > MAX_PREVIEW_FILE_BYTES) {
    throw new Error('Preview file is unexpectedly large.');
  }
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(
      'Preview file permissions are too open; restrict it to the current user (chmod 600).'
    );
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('Preview file must be owned by the current user.');
  }
};

export const getPreviewReadFlags = (
  platform = process.platform,
  constants = fsConstants
) => {
  if (
    platform === 'win32' ||
    !Number.isInteger(constants.O_NOFOLLOW) ||
    constants.O_NOFOLLOW === 0
  ) {
    throw new Error(
      'Applying a saved preview requires a platform with O_NOFOLLOW support, such as Linux or macOS.'
    );
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
};

export const savePreviewFile = async (file, previewRecord) => {
  const target = resolve(file);
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify(previewRecord, null, 2)}\n`,
      'utf8'
    );
  } catch (error) {
    await handle.close();
    await unlink(target).catch(() => undefined);
    throw error;
  }
  await handle.close();
  return target;
};

export const loadPreviewFile = async (file, expectedServerBase) => {
  const target = resolve(file);
  let handle;
  let record;
  try {
    handle = await open(target, getPreviewReadFlags());
    validatePreviewFileHandle(await handle.stat());
    record = JSON.parse(await handle.readFile('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error('Preview file is not valid JSON.');
    if (error?.code === 'ELOOP') {
      throw new Error('Preview file must be a regular file, not a symlink.');
    }
    throw error;
  } finally {
    await handle?.close();
  }
  if (
    Object.keys(record ?? {}).some(
      (key) =>
        ![
          'version',
          'serverBase',
          'serviceId',
          'format',
          'destinationRootPath',
          'authorIds',
          'sourceRootPath',
          'previewToken',
          'canMove',
        ].includes(key)
    ) ||
    record?.version !== 1 ||
    record.serverBase !== expectedServerBase ||
    !Number.isSafeInteger(record.serviceId) ||
    record.serviceId < 1 ||
    !['ebook', 'audiobook'].includes(record.format) ||
    !Array.isArray(record.authorIds) ||
    record.authorIds.length < 1 ||
    record.authorIds.length > 1000 ||
    !record.authorIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
    new Set(record.authorIds).size !== record.authorIds.length ||
    typeof record.destinationRootPath !== 'string' ||
    !record.destinationRootPath.trim() ||
    record.destinationRootPath.length > 4096 ||
    /[\0-\x1f\x7f]/.test(record.destinationRootPath) ||
    (record.sourceRootPath !== undefined &&
      (typeof record.sourceRootPath !== 'string' ||
        !record.sourceRootPath.trim() ||
        record.sourceRootPath.length > 4096 ||
        /[\0-\x1f\x7f]/.test(record.sourceRootPath))) ||
    record.canMove !== true ||
    typeof record.previewToken !== 'string' ||
    !record.previewToken ||
    record.previewToken.length > 512
  ) {
    throw new Error(
      'Preview file is incomplete or belongs to another SeerrNG URL.'
    );
  }
  return record;
};

const printJson = (data) =>
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);

export const run = async (args, env = process.env) => {
  const options = parseArgs(args);
  if (options.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  const credentials = getApiCredentials(env);

  if (options.apply) {
    const record = await loadPreviewFile(
      options.previewFile,
      credentials.serverBase
    );
    const { data } = await apiRequest(
      credentials,
      'POST',
      `/settings/readarr/${record.serviceId}/media-move/start`,
      {
        authorIds: record.authorIds,
        format: record.format,
        destinationRootPath: record.destinationRootPath,
        ...(record.sourceRootPath
          ? { sourceRootPath: record.sourceRootPath }
          : {}),
        previewToken: record.previewToken,
      }
    );
    await unlink(resolve(options.previewFile)).catch((error) => {
      process.stderr.write(
        `Move was accepted, but the preview file could not be removed: ${error.message}\n`
      );
    });
    printJson(data);
    return 0;
  }

  if (options.statusId) {
    const { data } = await apiRequest(
      credentials,
      'GET',
      `/settings/readarr/${options.serviceId}/media-move/commands/${options.statusId}`
    );
    printJson(data);
    return 0;
  }

  const move = {
    authorIds: options.authorIds.map(Number),
    format: options.format,
    destinationRootPath: options.destinationRootPath.trim(),
    ...(options.sourceRootPath
      ? { sourceRootPath: options.sourceRootPath }
      : {}),
  };
  const { data: preview } = await apiRequest(
    credentials,
    'POST',
    `/settings/readarr/${options.serviceId}/media-move/preview`,
    move
  );
  if (
    typeof preview?.previewToken !== 'string' ||
    !preview.previewToken ||
    preview.previewToken.length > 512 ||
    typeof preview.canMove !== 'boolean' ||
    !Array.isArray(preview.conflicts)
  ) {
    throw new Error('SeerrNG returned an invalid Bookshelf move preview.');
  }
  let previewFile;
  if (options.previewFile) {
    previewFile = await savePreviewFile(options.previewFile, {
      version: 1,
      serverBase: credentials.serverBase,
      serviceId: Number(options.serviceId),
      ...move,
      previewToken: preview.previewToken,
      canMove:
        preview.canMove === true &&
        (!preview.conflicts || preview.conflicts.length === 0),
    });
  }
  printJson({
    preview,
    ...(previewFile ? { previewFile } : {}),
    nextStep: preview.canMove
      ? previewFile
        ? `Review the preview, then apply it with: pnpm bookshelf:move -- --apply --preview-file ${previewFile} --yes`
        : 'Review the preview, then call the admin start API with this previewToken.'
      : 'Resolve the reported conflicts and create a fresh preview before applying.',
  });
  return 0;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Bookshelf media move failed.'}\n`
    );
    process.exitCode = 1;
  });
}
