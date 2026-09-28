import type ServarrBase from '@server/api/servarr/base';
import type { DownloadRecoveryServiceType } from '@server/entity/DownloadRecoveryState';
import { BoundedTaskQueue } from '@server/utils/concurrency';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { InterventionError } from './errors';
import type { InterventionQueueItem } from './identity';

const previews = new BoundedTaskQueue(3, 32);
export interface ImportCandidate {
  id: number;
  name: string;
  size: number;
  rejections: string[];
  eligible: boolean;
  file: Record<string, unknown>;
}
const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export async function importCandidates(
  type: DownloadRecoveryServiceType,
  api: Pick<ServarrBase<Record<string, never>>, 'getManualImportCandidates'>,
  item: InterventionQueueItem
): Promise<ImportCandidate[]> {
  if (
    (type !== 'radarr' && type !== 'sonarr') ||
    typeof item.outputPath !== 'string' ||
    !item.outputPath ||
    item.outputPath.length > 4000
  )
    throw new InterventionError(
      409,
      'Manual import requires a movie or series download with a known output folder.'
    );
  const targetId = type === 'radarr' ? item.movieId : item.seriesId;
  if (!positiveId(targetId))
    throw new InterventionError(
      409,
      'This download has no confirmed library target.'
    );
  const rows = await previews.run(() =>
    api.getManualImportCandidates({
      folder: item.outputPath!,
      downloadId: item.downloadId,
      ...(type === 'radarr' ? { movieId: targetId } : { seriesId: targetId }),
    })
  );
  const seen = new Set<number>();
  return rows.flatMap((row) => {
    if (
      !positiveId(row.id) ||
      seen.has(row.id) ||
      typeof row.path !== 'string' ||
      row.path.length > 4000
    )
      return [];
    seen.add(row.id);
    const movieId = row.movieId ?? object(row.movie).id;
    const seriesId = row.seriesId ?? object(row.series).id;
    const episodes = Array.isArray(row.episodes)
      ? row.episodes.map(object)
      : [];
    const episodeIds = episodes.map((episode) => episode.id).filter(positiveId);
    const paths = /^(?:[A-Za-z]:|\\)/.test(item.outputPath!)
      ? path.win32
      : path.posix;
    const relative = paths.relative(
      paths.normalize(item.outputPath!),
      paths.normalize(row.path)
    );
    const contained =
      relative !== '..' &&
      !relative.startsWith(`..${paths.sep}`) &&
      !paths.isAbsolute(relative);
    const targetMatches =
      type === 'radarr'
        ? movieId === targetId
        : seriesId === targetId &&
          episodeIds.length > 0 &&
          episodeIds.length <= 100;
    const downloadMatches =
      !row.downloadId || row.downloadId === item.downloadId;
    // Keep backend quality/language decisions. Browser selects IDs, never paths or target metadata.
    const file: Record<string, unknown> = {
      path: row.path,
      quality: row.quality,
      languages: row.languages,
      downloadId: item.downloadId,
      releaseGroup: row.releaseGroup,
      indexerFlags: row.indexerFlags,
    };
    if (type === 'radarr') file.movieId = movieId;
    else {
      file.seriesId = seriesId;
      file.episodeIds = episodeIds;
      file.releaseType = row.releaseType;
    }
    return [
      {
        id: row.id,
        name:
          typeof row.name === 'string'
            ? row.name.slice(0, 1000)
            : typeof row.relativePath === 'string'
              ? row.relativePath.slice(0, 1000)
              : 'File',
        size:
          typeof row.size === 'number' &&
          Number.isFinite(row.size) &&
          row.size >= 0
            ? row.size
            : 0,
        rejections: Array.isArray(row.rejections)
          ? row.rejections
              .slice(0, 20)
              .map((reason) =>
                String(object(reason).reason ?? '').slice(0, 4000)
              )
          : [],
        eligible:
          contained &&
          targetMatches &&
          downloadMatches &&
          !!row.quality &&
          Array.isArray(row.languages),
        file,
      },
    ];
  });
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
    throw Object.assign(new Error('Select between 1 and 50 distinct files.'), {
      status: 400,
    });
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

export const candidateFingerprint = (candidates: ImportCandidate[]) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        candidates.map(({ id, eligible, file }) => ({ id, eligible, file }))
      )
    )
    .digest('hex');
