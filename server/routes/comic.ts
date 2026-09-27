import ComicVineAPI from '@server/api/comicvine';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { Watchlist } from '@server/entity/Watchlist';
import { extractImageCacheUrls } from '@server/lib/imageCacheUrls';
import { enqueueImageCacheWarm } from '@server/lib/imageCacheWarmer';
import { hydrateMediaSummaryRelations } from '@server/lib/mediaSummaryHydration';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import {
  mapComicVineIssueResult,
  mapComicVineVolumeDetails,
} from '@server/models/Comic';
import { filterEntityResponse } from '@server/utils/entityResponse';
import { parsePositiveInt } from '@server/utils/pagination';
import { parsePositiveRouteId } from '@server/utils/routeId';
import { Router } from 'express';

const comicRoutes = Router();

comicRoutes.get('/:id/issues', async (req, res) => {
  const comicVineId = parsePositiveRouteId(req.params.id);
  if (comicVineId === undefined) {
    return res.status(404).json({ status: 404, message: 'Comic not found' });
  }
  const { comicVineApiKey } = getSettings().main;
  if (!comicVineApiKey) {
    return res
      .status(503)
      .json({ status: 503, message: 'ComicVine is not configured.' });
  }
  const page = parsePositiveInt(req.query.page, 1, 500);
  const itemsPerPage = 20;
  try {
    const response = await new ComicVineAPI(comicVineApiKey).getVolumeIssues({
      volumeId: comicVineId,
      page,
      limit: itemsPerPage,
    });
    const results = response.results.map(mapComicVineIssueResult);
    enqueueImageCacheWarm(extractImageCacheUrls(results));
    return res.status(200).json({
      page,
      totalPages: Math.ceil(response.number_of_total_results / itemsPerPage),
      totalResults: response.number_of_total_results,
      results,
    });
  } catch (error) {
    logger.error('Failed to retrieve comic issues', {
      label: 'Comic',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      comicVineId,
    });
    return res
      .status(503)
      .json({ status: 503, message: 'Unable to retrieve comic issues.' });
  }
});

comicRoutes.get('/:id', async (req, res, next) => {
  const comicVineId = parsePositiveRouteId(req.params.id);
  if (comicVineId === undefined) {
    return res.status(404).json({ status: 404, message: 'Comic not found' });
  }

  const { comicVineApiKey } = getSettings().main;
  if (!comicVineApiKey) {
    return next({
      status: 503,
      message: 'ComicVine is not configured on this server.',
    });
  }

  try {
    const comicVine = new ComicVineAPI(comicVineApiKey);
    const [volume, onUserWatchlist] = await Promise.all([
      comicVine.getVolume(comicVineId),
      req.user
        ? getRepository(Watchlist).exists({
            where: {
              externalId: String(comicVineId),
              mediaType: MediaType.COMIC,
              requestedBy: { id: req.user.id },
            },
          })
        : false,
    ]);
    if (!volume) {
      return res.status(404).json({ status: 404, message: 'Comic not found' });
    }

    const identifier = await getRepository(MediaIdentifier).findOne({
      where: {
        provider: MediaIdentifierProvider.COMICVINE,
        value: String(comicVineId),
      },
      relations: { media: true },
      relationLoadStrategy: 'query',
    });
    const media = identifier?.media
      ? (
          await hydrateMediaSummaryRelations([identifier.media], req.user, {
            includeIssues: true,
          })
        )[0]
      : undefined;

    const comicDetails = mapComicVineVolumeDetails(
      volume,
      media,
      onUserWatchlist
    );
    enqueueImageCacheWarm(extractImageCacheUrls(comicDetails));

    return res.status(200).json(filterEntityResponse(comicDetails, req.user));
  } catch (e) {
    logger.error('Failed to retrieve comic details', {
      label: 'Comic',
      errorMessage: e instanceof Error ? e.message : 'Unknown error',
      comicVineId,
    });
    return next({ status: 500, message: 'Unable to retrieve comic details.' });
  }
});

export default comicRoutes;
