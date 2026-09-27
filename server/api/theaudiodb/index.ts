import ExternalAPI from '@server/api/externalapi';
import { getRepository } from '@server/datasource';
import MetadataArtist from '@server/entity/MetadataArtist';
import cacheManager from '@server/lib/cache';
import {
  normalizeMusicBrainzId,
  prepareMusicBrainzBatchIds,
} from '@server/lib/externalIds';
import logger from '@server/logger';
import type { MusicRating } from '@server/models/Music';
import { mapWithConcurrency } from '@server/utils/concurrency';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { In } from 'typeorm';
import type { TadbAlbumResponse, TadbArtistResponse } from './interfaces';

const biographyPurify = DOMPurify(new JSDOM('').window);
// Match the approved Toy Story collection overview's maximum length.
export const ARTIST_OVERVIEW_MAX_LENGTH = 475;
export const conciseArtistBiography = (text: unknown): string => {
  if (typeof text !== 'string') return '';
  const cleaned = biographyPurify
    .sanitize(text.slice(0, 20000), { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
    .split(/\n\s*\n/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  const plain = [
    ...new Intl.Segmenter('en', { granularity: 'sentence' }).segment(cleaned),
  ]
    .slice(0, 3)
    .map((part) => part.segment)
    .join('')
    .trim();
  if (plain.length <= ARTIST_OVERVIEW_MAX_LENGTH) return plain;
  const excerpt = plain.slice(0, ARTIST_OVERVIEW_MAX_LENGTH - 1);
  const sentenceEnd = Math.max(
    excerpt.lastIndexOf('. '),
    excerpt.lastIndexOf('! '),
    excerpt.lastIndexOf('? ')
  );
  const wordEnd = excerpt.lastIndexOf(' ');
  return sentenceEnd > 150
    ? excerpt.slice(0, sentenceEnd + 1)
    : excerpt.slice(0, wordEnd > 0 ? wordEnd : excerpt.length) + '…';
};

const MAX_THEAUDIODB_IMAGE_URL_LENGTH = 2048;

export const sanitizeTheAudioDbImageUrl = (value: unknown): string | null => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > MAX_THEAUDIODB_IMAGE_URL_LENGTH
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      (url.port && url.port !== '443') ||
      url.username ||
      url.password ||
      (hostname !== 'theaudiodb.com' && !hostname.endsWith('.theaudiodb.com'))
    ) {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
};

class TheAudioDb extends ExternalAPI {
  private readonly apiKey = '195003';
  private readonly CACHE_TTL = 43200;
  private readonly STALE_THRESHOLD = 30 * 24 * 60 * 60 * 1000;
  static readonly BATCH_FETCH_CONCURRENCY = 5;

  constructor() {
    super(
      'https://www.theaudiodb.com/api/v1/json',
      {},
      {
        nodeCache: cacheManager.getCache('tadb').data,
        rateLimit: {
          maxRequests: 20,
          maxRPS: 25,
        },
      }
    );
  }

  private isMetadataStale(metadata: MetadataArtist | null): boolean {
    if (!metadata || !metadata.tadbUpdatedAt) return true;
    return Date.now() - metadata.tadbUpdatedAt.getTime() > this.STALE_THRESHOLD;
  }

  public async getArtistOverview(
    id: string
  ): Promise<{ text: string; url: string } | null> {
    const artistId = normalizeMusicBrainzId(id);
    const data = await this.get<TadbArtistResponse>(
      `/${this.apiKey}/artist-mb.php`,
      { params: { i: artistId }, timeout: 5000 },
      this.CACHE_TTL
    );
    const artist = data.artists?.find(
      (item) => item.strMusicBrainzID?.toLowerCase() === artistId
    );
    const text = conciseArtistBiography(
      artist?.strBiographyEN || artist?.strBiography
    );
    return text && /^\d+$/.test(artist?.idArtist ?? '')
      ? { text, url: `https://www.theaudiodb.com/artist/${artist!.idArtist}` }
      : null;
  }

  public async getAlbumRating(id: string): Promise<MusicRating | undefined> {
    const albumId = normalizeMusicBrainzId(id);
    const data = await this.get<TadbAlbumResponse>(
      `/${this.apiKey}/album-mb.php`,
      { params: { i: albumId }, timeout: 5000 },
      this.CACHE_TTL
    );
    const album = data.album?.find(
      (item) => item.strMusicBrainzID?.toLowerCase() === albumId
    );
    if (
      !album?.intScore ||
      !album.intScoreVotes ||
      !/^\d+$/.test(album.idAlbum ?? '')
    )
      return undefined;
    const score = Number(album.intScore),
      votes = Number(album.intScoreVotes);
    if (
      !Number.isFinite(score) ||
      score < 0 ||
      score > 10 ||
      !Number.isSafeInteger(votes) ||
      votes <= 0
    )
      return undefined;
    return {
      source: 'theaudiodb',
      score,
      votes,
      scale: 10,
      url: `https://www.theaudiodb.com/album/${album.idAlbum}`,
    };
  }

  private createEmptyResponse() {
    return { artistThumb: null, artistBackground: null };
  }

  public async getArtistImagesFromCache(id: string): Promise<
    | {
        artistThumb: string | null;
        artistBackground: string | null;
      }
    | null
    | undefined
  > {
    const artistId = normalizeMusicBrainzId(id);

    try {
      const metadata = await getRepository(MetadataArtist).findOne({
        where: { mbArtistId: artistId },
        select: { tadbThumb: true, tadbCover: true, tadbUpdatedAt: true },
      });

      if (metadata) {
        return {
          artistThumb: sanitizeTheAudioDbImageUrl(metadata.tadbThumb),
          artistBackground: sanitizeTheAudioDbImageUrl(metadata.tadbCover),
        };
      }
      return undefined;
    } catch (error) {
      logger.error('Failed to fetch artist images from cache', {
        label: 'TheAudioDb',
        id: artistId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  public async getArtistImages(
    id: string
  ): Promise<{ artistThumb: string | null; artistBackground: string | null }> {
    const artistId = normalizeMusicBrainzId(id);

    try {
      const metadata = await getRepository(MetadataArtist).findOne({
        where: { mbArtistId: artistId },
        select: { tadbThumb: true, tadbCover: true, tadbUpdatedAt: true },
      });

      if (metadata?.tadbThumb || metadata?.tadbCover) {
        return {
          artistThumb: sanitizeTheAudioDbImageUrl(metadata.tadbThumb),
          artistBackground: sanitizeTheAudioDbImageUrl(metadata.tadbCover),
        };
      }

      if (metadata && !this.isMetadataStale(metadata)) {
        return this.createEmptyResponse();
      }

      return await this.fetchArtistImages(artistId);
    } catch (error) {
      logger.error('Failed to get artist images', {
        label: 'TheAudioDb',
        id: artistId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return this.createEmptyResponse();
    }
  }

  private async fetchArtistImages(id: string): Promise<{
    artistThumb: string | null;
    artistBackground: string | null;
  }> {
    const artistId = normalizeMusicBrainzId(id);

    try {
      const data = await this.get<TadbArtistResponse>(
        `/${this.apiKey}/artist-mb.php`,
        { params: { i: artistId } },
        this.CACHE_TTL
      );

      const result = {
        artistThumb: sanitizeTheAudioDbImageUrl(
          Array.isArray(data?.artists)
            ? data.artists[0]?.strArtistThumb
            : undefined
        ),
        artistBackground: sanitizeTheAudioDbImageUrl(
          Array.isArray(data?.artists)
            ? data.artists[0]?.strArtistFanart
            : undefined
        ),
      };

      const metadataRepository = getRepository(MetadataArtist);
      await metadataRepository
        .upsert(
          {
            mbArtistId: artistId,
            tadbThumb: result.artistThumb,
            tadbCover: result.artistBackground,
            tadbUpdatedAt: new Date(),
          },
          {
            conflictPaths: ['mbArtistId'],
          }
        )
        .catch((e) => {
          logger.error('Failed to save artist metadata', {
            label: 'TheAudioDb',
            error: e instanceof Error ? e.message : 'Unknown error',
          });
        });

      return result;
    } catch (error) {
      // TheAudioDb signals "no artist found" with a normal 200 response
      // (handled in the try block above, which already persists a
      // confirmed-empty result). Anything that lands here is a genuine
      // request failure (timeout, network error, non-2xx status), so it
      // must not be cached as a permanent negative result — let the next
      // request retry instead of serving stale empty images for up to
      // STALE_THRESHOLD (30 days).
      logger.warn(
        'Transient failure fetching artist images, will retry on next request',
        {
          label: 'TheAudioDb',
          id: artistId,
          errorMessage:
            error instanceof Error ? error.message : 'Unknown error',
        }
      );
      return this.createEmptyResponse();
    }
  }

  public async batchGetArtistImages(ids: string[]): Promise<
    Record<
      string,
      {
        artistThumb: string | null;
        artistBackground: string | null;
      }
    >
  > {
    if (!ids.length) return {};
    const normalizedIds = prepareMusicBrainzBatchIds(ids);
    if (!normalizedIds.length) return {};

    const metadataRepository = getRepository(MetadataArtist);
    const existingMetadata = await metadataRepository.find({
      where: { mbArtistId: In(normalizedIds) },
      select: {
        mbArtistId: true,
        tadbThumb: true,
        tadbCover: true,
        tadbUpdatedAt: true,
      },
    });

    const results: Record<
      string,
      {
        artistThumb: string | null;
        artistBackground: string | null;
      }
    > = {};
    const idsToFetch: string[] = [];

    normalizedIds.forEach((id) => {
      const metadata = existingMetadata.find(
        (m) => normalizeMusicBrainzId(m.mbArtistId) === id
      );

      if (metadata?.tadbThumb || metadata?.tadbCover) {
        results[id] = {
          artistThumb: sanitizeTheAudioDbImageUrl(metadata.tadbThumb),
          artistBackground: sanitizeTheAudioDbImageUrl(metadata.tadbCover),
        };
      } else if (metadata && !this.isMetadataStale(metadata)) {
        results[id] = {
          artistThumb: null,
          artistBackground: null,
        };
      } else {
        idsToFetch.push(id);
      }
    });

    if (idsToFetch.length > 0) {
      await mapWithConcurrency(
        idsToFetch,
        TheAudioDb.BATCH_FETCH_CONCURRENCY,
        async (id) =>
          this.fetchArtistImages(id)
            .then((response) => {
              results[id] = response;
              return true;
            })
            .catch(() => {
              results[id] = {
                artistThumb: null,
                artistBackground: null,
              };
              return false;
            })
      );
    }

    return results;
  }
}

export default TheAudioDb;
