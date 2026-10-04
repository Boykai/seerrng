import AudiobookshelfAPI, {
  type AudiobookshelfLibraryItem,
} from '@server/api/audiobookshelf';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { normalizeValidIsbn } from '@server/lib/isbn';
import type {
  ProcessOptions,
  RunnableScanner,
  StatusBase,
} from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import logger from '@server/logger';

const PAGE_SIZE = 100;
const MAX_LIBRARY_PAGES = 10_000;

class AudiobookshelfScanner
  extends BaseScanner<AudiobookshelfLibraryItem>
  implements RunnableScanner<StatusBase>
{
  private serviceId?: number;
  private seenItemIds = new Set<string>();

  constructor() {
    super('Audiobookshelf Scan', { bundleSize: 10 });
  }

  public status(): StatusBase {
    return {
      running: this.running,
      progress: this.progress,
      total: this.items.length,
    };
  }

  public async run(): Promise<void> {
    const settings = getExternalRuntimeConfig().audiobookshelf;
    if (!settings?.syncEnabled) return;

    const sessionId = this.startRun();
    if (!sessionId) return;

    this.serviceId = settings.id;
    this.seenItemIds.clear();

    try {
      const api = new AudiobookshelfAPI(settings);
      const items: AudiobookshelfLibraryItem[] = [];
      let total = Number.POSITIVE_INFINITY;
      let firstPageTotal: number | undefined;

      for (let page = 0; page < MAX_LIBRARY_PAGES; page += 1) {
        const result = await api.getLibraryItems(
          settings.libraryId,
          page,
          PAGE_SIZE
        );
        total = result.total;
        if (firstPageTotal === undefined) {
          firstPageTotal = total;
        } else if (total !== firstPageTotal) {
          throw new Error(
            'Audiobookshelf library changed during the scan. Orphan cleanup was skipped; the next scan will retry.'
          );
        }
        items.push(...result.results);

        if (items.length >= total) break;
        if (result.results.length === 0) {
          throw new Error(
            'Audiobookshelf returned an incomplete library scan. Orphan cleanup was skipped.'
          );
        }
      }

      if (items.length < total) {
        throw new Error(
          'Audiobookshelf library exceeds the scan page limit. Orphan cleanup was skipped.'
        );
      }

      this.items = items;
      this.seenItemIds = new Set(
        items.map((item) => item.id).filter((id): id is string => !!id)
      );
      await this.loop(this.processItem.bind(this), { sessionId });
      await this.cleanupRemovedItems();
      logger.info('Audiobookshelf library scan complete', {
        label: 'Audiobookshelf',
        itemCount: items.length,
      });
    } catch (error) {
      logger.error('Audiobookshelf library scan failed', {
        label: 'Audiobookshelf',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.endRun(sessionId);
      this.serviceId = undefined;
    }
  }

  private async processItem(item: AudiobookshelfLibraryItem): Promise<void> {
    const itemId = typeof item.id === 'string' ? item.id.trim() : '';
    const isbn = normalizeValidIsbn(item.media?.metadata?.isbn ?? undefined);
    if (!itemId || !isbn || this.serviceId === undefined) {
      return;
    }

    const options: ProcessOptions = {
      title: item.media?.metadata?.title ?? 'Audiobookshelf book',
      hasFile: true,
      bookServiceType: 'audiobook',
      audiobookLibrarySource: { serviceId: this.serviceId, itemId },
      mediaAddedAt:
        typeof item.addedAt === 'number' && Number.isFinite(item.addedAt)
          ? new Date(item.addedAt)
          : undefined,
      secondaryIdentifiers: [
        { provider: MediaIdentifierProvider.AUDIOBOOKSHELF, value: itemId },
      ],
    };

    await this.processBook(MediaIdentifierProvider.ISBN, isbn, options);
  }

  private async cleanupRemovedItems(): Promise<void> {
    if (this.serviceId === undefined) return;

    const mediaRepository = getRepository(Media);
    const identifierRepository = getRepository(MediaIdentifier);
    const tracked = await mediaRepository.find({
      where: {
        mediaType: MediaType.BOOK,
        audiobookLibraryServiceId: this.serviceId,
      },
      relations: { identifiers: true },
    });

    for (const media of tracked) {
      const itemId = media.audiobookLibraryItemId;
      if (!itemId || this.seenItemIds.has(itemId)) continue;

      media.audiobookLibraryServiceId = null;
      media.audiobookLibraryItemId = null;
      if (
        media.status === MediaStatus.AVAILABLE &&
        media.externalServiceId == null &&
        media.audiobookExternalServiceId == null
      ) {
        media.status = MediaStatus.UNKNOWN;
      }

      await mediaRepository.save(media);
      const sourceIdentifier = media.identifiers?.find(
        (identifier) =>
          identifier.provider === MediaIdentifierProvider.AUDIOBOOKSHELF &&
          identifier.value === itemId
      );
      if (sourceIdentifier) await identifierRepository.remove(sourceIdentifier);
    }
  }
}

export const audiobookshelfScanner = new AudiobookshelfScanner();
