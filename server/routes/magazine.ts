import LazyLibrarianAPI from '@server/api/lazylibrarian';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import MediaIdentifier, {
  MediaIdentifierProvider,
} from '@server/entity/MediaIdentifier';
import { Watchlist } from '@server/entity/Watchlist';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { normalizeMagazineTitle } from '@server/lib/magazineIdentity';
import { hydrateMediaSummaryRelations } from '@server/lib/mediaSummaryHydration';
import { runWithServarrServiceSnapshot } from '@server/lib/serviceAdmission';
import logger from '@server/logger';
import { mapLazyLibrarianMagazineDetails } from '@server/models/Magazine';
import { filterEntityResponse } from '@server/utils/entityResponse';
import { getHttpErrorDetails } from '@server/utils/httpError';
import { parsePositiveRouteId } from '@server/utils/routeId';
import { parseBoundedString } from '@server/utils/validation';
import { Router } from 'express';

const magazineRoutes = Router();
const maxServiceId = 1_000_000_000;
const maxMagazineDetailLookupMs = 20_000;

magazineRoutes.get('/cover/:serviceId/:coverId', async (req, res) => {
  const serviceId = parsePositiveRouteId(req.params.serviceId, maxServiceId);
  const coverId = req.params.coverId;
  const service = serviceId
    ? getExternalRuntimeConfig().lazylibrarian.find(
        (candidate) => candidate.id === serviceId
      )
    : undefined;

  if (!service || !/^(?:[a-f\d]{32}|[a-f\d]{40})$/i.test(coverId)) {
    return res.status(404).send('Magazine cover not found.');
  }

  try {
    const cover = await runWithServarrServiceSnapshot(
      'lazylibrarian',
      service,
      (current) =>
        new LazyLibrarianAPI({
          url: LazyLibrarianAPI.buildUrl(current),
          apiKey: current.apiKey,
        }).getMagazineCover(coverId)
    );

    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', cover.contentType);
    res.setHeader('Content-Length', cover.imageBuffer.length);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(cover.imageBuffer);
  } catch (error) {
    logger.warn('Failed to retrieve LazyLibrarian magazine cover', {
      label: 'Magazine',
      serviceId,
      errorMessage: getHttpErrorDetails(error).errorMessage,
    });
    return res.status(404).send('Magazine cover not found.');
  }
});

magazineRoutes.get('/:title', async (req, res, next) => {
  const parsed = parseBoundedString(req.params.title, {
    fieldName: 'Magazine title',
    maxLength: 256,
  });
  if ('error' in parsed) {
    return res
      .status(404)
      .json({ status: 404, message: 'Magazine not found.' });
  }
  const title = parsed.value.trim().replace(/\s+/g, ' ');
  const normalizedTitle = normalizeMagazineTitle(title);
  if (!normalizedTitle) {
    return res
      .status(404)
      .json({ status: 404, message: 'Magazine not found.' });
  }

  try {
    const [identifier, onUserWatchlist] = await Promise.all([
      getRepository(MediaIdentifier).findOne({
        where: {
          provider: MediaIdentifierProvider.LAZYLIBRARIAN,
          value: normalizedTitle,
        },
        relations: { media: true },
        relationLoadStrategy: 'query',
      }),
      req.user
        ? getRepository(Watchlist).exists({
            where: {
              externalId: normalizedTitle,
              mediaType: MediaType.MAGAZINE,
              requestedBy: { id: req.user.id },
            },
          })
        : false,
    ]);
    const media = identifier?.media
      ? (
          await hydrateMediaSummaryRelations([identifier.media], req.user, {
            includeIssues: true,
          })
        )[0]
      : undefined;
    const settings = getExternalRuntimeConfig();
    const serviceRank = (service: (typeof settings.lazylibrarian)[number]) =>
      service.id === media?.serviceId ? 0 : service.isDefault ? 1 : 2;
    const services = [...settings.lazylibrarian].sort(
      (left, right) => serviceRank(left) - serviceRank(right)
    );
    const detailLookupSignal = AbortSignal.timeout(maxMagazineDetailLookupMs);

    let magazine = { title };
    let issues: Awaited<ReturnType<LazyLibrarianAPI['getIssues']>>['issues'] =
      [];
    let serviceId: number | undefined;
    let reachedService = false;
    let foundDetails = false;
    let lookupTimedOut = false;
    for (const service of services) {
      if (detailLookupSignal.aborted) {
        lookupTimedOut = true;
        break;
      }
      try {
        const detail = await runWithServarrServiceSnapshot(
          'lazylibrarian',
          service,
          (current) =>
            new LazyLibrarianAPI({
              url: LazyLibrarianAPI.buildUrl(current),
              apiKey: current.apiKey,
            }).getIssues(
              current.id === media?.serviceId
                ? (media?.externalServiceSlug ?? title)
                : title,
              detailLookupSignal
            )
        );
        reachedService = true;
        if (detail.magazine || detail.issues.length > 0) {
          foundDetails = true;
          magazine = detail.magazine ?? { title };
          issues = detail.issues;
          serviceId = service.id;
          break;
        }
      } catch (error) {
        lookupTimedOut ||= detailLookupSignal.aborted;
        logger.warn('Failed to retrieve magazine details from service', {
          label: 'Magazine',
          serviceId: service.id,
          errorMessage: getHttpErrorDetails(error).errorMessage,
        });
      }
    }
    if (
      services.length > 0 &&
      (!reachedService || (lookupTimedOut && !foundDetails))
    ) {
      return next({
        status: 503,
        message: 'Unable to retrieve magazine details.',
      });
    }

    return res
      .status(200)
      .json(
        filterEntityResponse(
          mapLazyLibrarianMagazineDetails(
            magazine,
            issues,
            media,
            onUserWatchlist,
            serviceId
          ),
          req.user
        )
      );
  } catch (error) {
    logger.error('Failed to retrieve magazine details', {
      label: 'Magazine',
      errorMessage: getHttpErrorDetails(error).errorMessage,
    });
    return next({
      status: 503,
      message: 'Unable to retrieve magazine details.',
    });
  }
});

export default magazineRoutes;
