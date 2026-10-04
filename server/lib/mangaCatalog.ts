import { AnilistRateLimitedError } from '@server/api/anilist/failures';
import type { AnilistMangaContentPolicy } from '@server/api/anilist/manga';
import { ANILIST_MAX_RETRY_AFTER_SECONDS } from '@server/api/anilist/rateLimiter';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MangaSourceBinding, {
  MangaBindingState,
} from '@server/entity/MangaSourceBinding';
import type Media from '@server/entity/Media';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import type { User } from '@server/entity/User';
import { hydrateMediaSummaryRelations } from '@server/lib/mediaSummaryHydration';
import { getSettings } from '@server/lib/settings';
import type { Response } from 'express';
import { In } from 'typeorm';

export const getMangaContentPolicy = (): AnilistMangaContentPolicy => {
  const { mangaIncludeAdult, mangaIncludeNovels } = getSettings().main;
  return {
    includeAdult: mangaIncludeAdult === true,
    includeNovels: mangaIncludeNovels === true,
  };
};

export const findMangaMediaByAnilistIds = async (
  anilistIds: number[],
  user?: User
): Promise<Map<number, Media>> => {
  const values = [...new Set(anilistIds)].map(String);
  if (!values.length) {
    return new Map();
  }

  const identifiers = await getRepository(MediaIdentifier).find({
    where: {
      provider: MediaIdentifierProvider.ANILIST,
      value: In(values),
    },
    relations: { media: true },
    relationLoadStrategy: 'query',
  });

  const linked = identifiers.filter(
    (identifier) => identifier.media?.mediaType === MediaType.MANGA
  );
  const media = await hydrateMediaSummaryRelations(
    linked.map((identifier) => identifier.media),
    user
  );
  const mediaById = new Map(media.map((item) => [item.id, item]));

  return new Map(
    linked.flatMap((identifier) => {
      const resolved = mediaById.get(identifier.media.id);
      return resolved ? [[Number(identifier.value), resolved] as const] : [];
    })
  );
};

export const getAnilistRetryAfterSeconds = (
  error: AnilistRateLimitedError
): number =>
  Math.max(
    1,
    Math.min(ANILIST_MAX_RETRY_AFTER_SECONDS, error.retryAfterSeconds || 60)
  );

/**
 * Whether a library scan found this title in an administrator's Suwayomi
 * library: an active binding the latest listing contained.
 */
export const isMangaInSuwayomiLibrary = (anilistId: number): Promise<boolean> =>
  getRepository(MangaSourceBinding).existsBy({
    anilistId,
    state: MangaBindingState.ACTIVE,
    inLibrary: true,
  });

// AniList rate limits surface as 429 with Retry-After; anything else means
// the catalog is unavailable right now.
export const sendAnilistFailure = (
  res: Response,
  error: unknown,
  message: string
): Response => {
  if (error instanceof AnilistRateLimitedError) {
    res.set('Retry-After', String(getAnilistRetryAfterSeconds(error)));
    return res.status(429).json({
      status: 429,
      message: 'AniList rate limit reached. Try again later.',
    });
  }
  return res.status(503).json({ status: 503, message });
};
