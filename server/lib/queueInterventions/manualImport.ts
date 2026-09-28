import type { DownloadRecoveryServiceType } from '@server/entity/DownloadRecoveryState';
import { BoundedTaskQueue } from '@server/utils/concurrency';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { InterventionError } from './errors';
import type { InterventionQueueItem } from './identity';

const previews = new BoundedTaskQueue(3, 32);
const MAX_IMPORT_CANDIDATES = 1000;
export interface ImportCandidate {
  id: number;
  name: string;
  size: number;
  rejections: string[];
  eligible: boolean;
  file: Record<string, unknown>;
}

export interface ImportTarget {
  id: number;
  title: string;
  subtitle?: string;
  parentId?: number;
}

export interface ManualImportQuery {
  folder: string;
  downloadId?: string;
  filterExistingFiles: false;
  replaceExistingFiles: false;
  movieId?: number;
  seriesId?: number;
  artistId?: number;
  authorId?: number;
}

export interface ManualImportSource {
  getManualImportCandidates(
    params: ManualImportQuery
  ): Promise<Record<string, unknown>[]>;
  getTargets(): Promise<ImportTarget[]>;
  getTarget(id: number): Promise<ImportTarget | undefined>;
}

const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const boundedText = (value: unknown, limit: number): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, limit)
    : undefined;

const queueTargetId = (
  type: DownloadRecoveryServiceType,
  item: InterventionQueueItem
): number | undefined => {
  const id =
    type === 'radarr'
      ? item.movieId
      : type === 'sonarr'
        ? item.seriesId
        : type === 'lidarr'
          ? item.albumId
          : item.bookId;
  return positiveId(id) ? id : undefined;
};

const targetQuery = (
  type: DownloadRecoveryServiceType,
  target: ImportTarget | undefined
): Pick<
  ManualImportQuery,
  'movieId' | 'seriesId' | 'artistId' | 'authorId'
> => {
  if (!target) return {};
  switch (type) {
    case 'radarr':
      return { movieId: target.id };
    case 'sonarr':
      return { seriesId: target.id };
    case 'lidarr':
      return positiveId(target.parentId) ? { artistId: target.parentId } : {};
    case 'readarr':
      return positiveId(target.parentId) ? { authorId: target.parentId } : {};
  }
};

const candidateTarget = (
  type: DownloadRecoveryServiceType,
  row: Record<string, unknown>
) => {
  switch (type) {
    case 'radarr':
      return { id: row.movieId ?? object(row.movie).id };
    case 'sonarr':
      return { id: row.seriesId ?? object(row.series).id };
    case 'lidarr':
      return {
        id: row.albumId ?? object(row.album).id,
        parentId:
          row.artistId ??
          object(row.artist).id ??
          object(object(row.album).artist).id,
      };
    case 'readarr':
      return {
        id: row.bookId ?? object(row.book).id,
        parentId: row.authorId ?? object(row.author).id,
      };
  }
};

export async function importTargets(
  source: ManualImportSource,
  query: string
): Promise<ImportTarget[]> {
  const normalized = query.trim().toLowerCase();
  if (normalized.length < 2 || normalized.length > 120)
    throw new InterventionError(
      400,
      'Search with between 2 and 120 characters.'
    );

  const rows = await previews.run(() => source.getTargets());
  return rows
    .flatMap((target) => {
      const title = boundedText(target.title, 500);
      const subtitle = boundedText(target.subtitle, 500);
      if (
        !positiveId(target.id) ||
        !title ||
        (!title.toLowerCase().includes(normalized) &&
          !subtitle?.toLowerCase().includes(normalized))
      ) {
        return [];
      }
      return [{ id: target.id, title, subtitle: subtitle ?? '' }];
    })
    .sort((left, right) => {
      const leftText = `${left.title} ${left.subtitle ?? ''}`.toLowerCase();
      const rightText = `${right.title} ${right.subtitle ?? ''}`.toLowerCase();
      const leftScore = leftText.startsWith(normalized) ? 0 : 1;
      const rightScore = rightText.startsWith(normalized) ? 0 : 1;
      return leftScore - rightScore || leftText.localeCompare(rightText);
    })
    .slice(0, 20)
    .map(({ id, title, subtitle }) => ({ id, title, subtitle }));
}

export async function importCandidates(
  type: DownloadRecoveryServiceType,
  source: ManualImportSource,
  item: InterventionQueueItem,
  requestedTargetId?: number
): Promise<{ candidates: ImportCandidate[]; target?: ImportTarget }> {
  if (
    typeof item.outputPath !== 'string' ||
    !item.outputPath ||
    item.outputPath.length > 4000
  )
    throw new InterventionError(
      409,
      'Manual import requires a known output folder.'
    );

  const targetId = requestedTargetId ?? queueTargetId(type, item);
  let target: ImportTarget | undefined;
  if (targetId !== undefined) {
    if (!positiveId(targetId))
      throw new InterventionError(400, 'Choose a valid library match.');
    target = await source.getTarget(targetId);
    const title = boundedText(target?.title, 500);
    const subtitle = boundedText(target?.subtitle, 500);
    if (
      !target ||
      target.id !== targetId ||
      !title ||
      ((type === 'lidarr' || type === 'readarr') &&
        !positiveId(target.parentId))
    )
      throw new InterventionError(
        409,
        'The selected library match is no longer available. Search again.'
      );
    target = {
      id: target.id,
      title,
      ...(subtitle ? { subtitle } : {}),
      ...(target.parentId !== undefined ? { parentId: target.parentId } : {}),
    };
  }

  const rows = await previews.run(() =>
    source.getManualImportCandidates({
      folder: item.outputPath!,
      ...(item.downloadId ? { downloadId: item.downloadId } : {}),
      // This inbox handles files automatic import skipped; do not hide unmatched files.
      filterExistingFiles: false,
      replaceExistingFiles: false,
      ...targetQuery(type, target),
    })
  );
  if (rows.length > MAX_IMPORT_CANDIDATES)
    throw new InterventionError(
      409,
      'This folder has too many files for a safe manual import preview. Narrow the folder in the acquisition service and try again.'
    );
  const seen = new Set<number>();
  const paths = /^(?:[A-Za-z]:|\\\\)/.test(item.outputPath)
    ? path.win32
    : path.posix;

  const candidates = rows.flatMap((row) => {
    if (
      !positiveId(row.id) ||
      seen.has(row.id) ||
      typeof row.path !== 'string' ||
      row.path.length > 4000
    )
      return [];
    seen.add(row.id);

    const relative = paths.relative(
      paths.normalize(item.outputPath!),
      paths.normalize(row.path)
    );
    const contained =
      relative !== '' &&
      relative !== '.' &&
      relative !== '..' &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative);
    const mapped = candidateTarget(type, row);
    const targetMatches =
      !!target &&
      mapped.id === target.id &&
      (type === 'radarr' || type === 'sonarr'
        ? true
        : mapped.parentId === target.parentId);
    const downloadMatches =
      !row.downloadId || row.downloadId === item.downloadId;
    const quality = object(row.quality);
    const languages = Array.isArray(row.languages)
      ? row.languages.slice(0, 100)
      : undefined;
    const indexerFlags = positiveId(row.indexerFlags) ? row.indexerFlags : 0;
    const releaseGroup = boundedText(row.releaseGroup, 500);
    const baseFile: Record<string, unknown> = {
      path: row.path,
      quality,
      downloadId: item.downloadId,
      indexerFlags,
      ...(releaseGroup ? { releaseGroup } : {}),
    };

    let file: Record<string, unknown>;
    let backendFieldsValid = Object.keys(quality).length > 0;
    if (type === 'radarr') {
      file = { ...baseFile, movieId: target?.id ?? mapped.id, languages };
      backendFieldsValid = backendFieldsValid && Array.isArray(languages);
    } else if (type === 'sonarr') {
      const seriesId = target?.id ?? mapped.id;
      const episodes = Array.isArray(row.episodes)
        ? row.episodes.slice(0, 100).map(object)
        : [];
      const episodeIds = episodes
        .map((episode) => episode.id)
        .filter(positiveId);
      file = {
        ...baseFile,
        seriesId,
        episodeIds,
        languages,
        releaseType: row.releaseType,
      };
      backendFieldsValid =
        backendFieldsValid &&
        episodeIds.length > 0 &&
        episodeIds.length === episodes.length &&
        Array.isArray(languages);
    } else if (type === 'lidarr') {
      const tracks = Array.isArray(row.tracks)
        ? row.tracks.slice(0, 100).map(object)
        : [];
      const trackIds = tracks.map((track) => track.id).filter(positiveId);
      const albumReleaseId = row.albumReleaseId;
      file = {
        ...baseFile,
        artistId: target?.parentId ?? mapped.parentId,
        albumId: target?.id ?? mapped.id,
        albumReleaseId,
        trackIds,
      };
      backendFieldsValid =
        backendFieldsValid &&
        positiveId(albumReleaseId) &&
        trackIds.length > 0 &&
        trackIds.length === tracks.length;
    } else {
      const foreignEditionId = boundedText(row.foreignEditionId, 200);
      file = {
        ...baseFile,
        authorId: target?.parentId ?? mapped.parentId,
        bookId: target?.id ?? mapped.id,
        ...(foreignEditionId ? { foreignEditionId } : {}),
      };
      backendFieldsValid = backendFieldsValid && !!foreignEditionId;
    }

    return [
      {
        id: row.id,
        name:
          boundedText(row.name, 1000) ??
          boundedText(row.relativePath, 1000) ??
          'File',
        size:
          typeof row.size === 'number' &&
          Number.isFinite(row.size) &&
          row.size >= 0
            ? row.size
            : 0,
        rejections: Array.isArray(row.rejections)
          ? row.rejections
              .slice(0, 10)
              .map((reason) =>
                String(
                  typeof reason === 'string'
                    ? reason
                    : (object(reason).reason ?? object(reason).message ?? '')
                ).slice(0, 500)
              )
          : [],
        eligible:
          contained && targetMatches && downloadMatches && backendFieldsValid,
        file,
      },
    ];
  });

  return { candidates, target };
}

export function selectImportFiles(
  candidates: ImportCandidate[],
  ids: number[]
): Record<string, unknown>[] {
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > 50 ||
    new Set(ids).size !== ids.length ||
    !ids.every(positiveId)
  )
    throw new InterventionError(400, 'Select between 1 and 50 distinct files.');
  return ids.map((id) => {
    const candidate = candidates.find((candidate) => candidate.id === id);
    if (!candidate?.eligible)
      throw new InterventionError(
        409,
        'A selected file changed or has no confirmed library target. Preview again.'
      );
    return candidate.file;
  });
}

export const candidateFingerprint = (
  candidates: ImportCandidate[],
  targetId?: number
) =>
  createHash('sha256')
    .update(
      JSON.stringify({
        targetId: targetId ?? null,
        candidates: candidates.map(({ id, eligible, file }) => ({
          id,
          eligible,
          file,
        })),
      })
    )
    .digest('hex');
