import type { QueueItem } from '@server/api/servarr/base';
import type { DownloadRecoveryServiceType } from '@server/entity/DownloadRecoveryState';
import type { DVRSettings } from '@server/lib/settings';
import { createHash } from 'node:crypto';

export type InterventionQueueItem = QueueItem & {
  outputPath?: string;
  movieId?: number;
  seriesId?: number;
  albumId?: number;
  bookId?: number;
};
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const serviceAuthority = (
  type: DownloadRecoveryServiceType,
  server: DVRSettings
) =>
  hash([
    type,
    server.id,
    server.hostname,
    server.port,
    server.useSsl,
    server.baseUrl,
    server.apiKey,
    server.syncEnabled,
    server.is4k,
    'serviceType' in server ? server.serviceType : undefined,
  ]);
export const queueIdentity = (authority: string, item: InterventionQueueItem) =>
  hash([
    authority,
    item.id,
    item.downloadId || '',
    item.movieId,
    item.seriesId,
    item.albumId,
    item.bookId,
    item.title,
    item.size,
  ]);
export const isActionableQueueItem = (item: InterventionQueueItem): boolean =>
  /warning|error|failed|blocked/i.test(
    [item.status, item.trackedDownloadStatus, item.trackedDownloadState].join(
      ' '
    )
  ) ||
  (Array.isArray(item.statusMessages) && item.statusMessages.length > 0);
export function safeDiagnostic(value: unknown, secret: string): string {
  if (typeof value !== 'string') return '';
  return value
    .slice(0, 4000)
    .split(secret || '\0')
    .join('[redacted]')
    .replace(
      /((?:api[-_]?key|access[-_]?token|password|authorization)\s*[=:]\s*)[^\s&]+/gi,
      '$1[redacted]'
    )
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, '$1[redacted]@');
}
export const warningText = (
  item: InterventionQueueItem,
  secret: string
): string =>
  JSON.stringify(
    (Array.isArray(item.statusMessages) ? item.statusMessages : [])
      .slice(0, 20)
      .flatMap((message) => [
        message?.title,
        ...(Array.isArray(message?.messages)
          ? message.messages.slice(0, 20)
          : []),
      ])
      .map((message) => safeDiagnostic(message, secret))
      .filter(Boolean)
      .slice(0, 40)
  );
