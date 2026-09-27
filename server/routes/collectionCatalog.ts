import TheMovieDb from '@server/api/themoviedb';
import Tvdb from '@server/api/tvdb';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import { getCuratedCollection } from '@server/lib/collectionCatalog';
import { getTvCollectionName } from '@server/lib/collectionName';
import { checkCollection } from '@server/lib/collectionSync';
import { isValidMusicBrainzResourceId } from '@server/lib/externalIds';
import { getExternalRuntimeConfig } from '@server/lib/externalRuntimeConfig';
import { getAvailableMusicQualities } from '@server/lib/musicQualityAvailability';
import { Permission } from '@server/lib/permissions';
import { isAuthenticated } from '@server/middleware/auth';
import { Router } from 'express';

const router = Router();
const positiveId = (id: string) => /^[1-9]\d{0,8}$/.test(id);
router.get('/tv/for-series/:id', async (req, res, next) => {
  if (!positiveId(req.params.id)) return res.sendStatus(404);
  try {
    const show = await new TheMovieDb().getTvShow({
      tvId: Number(req.params.id),
    });
    const tvdbId = show.external_ids?.tvdb_id;
    return res.json({
      collections: tvdbId
        ? (await (await Tvdb.getInstance()).getSeriesCollections(tvdbId)).map(
            (collection) => ({
              ...collection,
              name: getTvCollectionName(collection.name),
            })
          )
        : [],
    });
  } catch {
    return next({
      status: 503,
      message: 'Cannot check series collections right now.',
    });
  }
});

router.use('/:kind/:id', (req, res, next) => {
  if (
    (req.params.kind !== 'tv' && req.params.kind !== 'music') ||
    !(req.params.kind === 'music'
      ? isValidMusicBrainzResourceId(req.params.id)
      : positiveId(req.params.id))
  )
    return res.sendStatus(404);
  return next();
});

for (const method of ['get', 'post'] as const) {
  router[method](
    method === 'get' ? '/:kind/:id' : '/:kind/:id/availability',
    async (req, res, next) => {
      try {
        const kind = req.params.kind as 'tv' | 'music';
        const collection = await getCuratedCollection(kind, req.params.id);
        const sync =
          method === 'post'
            ? await checkCollection(req.params.id, undefined, undefined, {
                kind,
              })
            : undefined;
        const media = await Media.getRelatedMedia(
          req.user,
          kind === 'music'
            ? collection.parts.map((part) => part.id)
            : collection.parts.map((part) => ({
                tmdbId: Number(part.id),
                mediaType: MediaType.TV,
              }))
        );
        const musicServices =
          kind === 'music' ? getExternalRuntimeConfig().lidarr : [];
        collection.parts = collection.parts.map((part) => {
          const mediaInfo = media.find((item) =>
            kind === 'music'
              ? item.mbId === part.id
              : item.tmdbId === Number(part.id) &&
                item.mediaType === MediaType.TV
          );
          return {
            ...part,
            mediaInfo,
            ...(kind === 'music'
              ? {
                  availableQualities: getAvailableMusicQualities(
                    mediaInfo,
                    mediaInfo?.requests ?? [],
                    musicServices
                  ),
                }
              : {}),
          };
        });
        if (method === 'get') return res.json(collection);
        return res.json({
          collection,
          sync: {
            ...sync!,
            destinations: req.user?.hasPermission(Permission.ADMIN)
              ? sync!.destinations
              : [],
          },
        });
      } catch {
        return next({
          status: 503,
          message: 'Cannot load or verify this collection right now.',
        });
      }
    }
  );
}

router.post(
  '/:kind/:id/server',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const { libraryIds, selectedIds } = req.body ?? {};
    if (
      !Array.isArray(libraryIds) ||
      !libraryIds.length ||
      libraryIds.length > 50 ||
      libraryIds.some(
        (id) => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(id)
      ) ||
      !Array.isArray(selectedIds) ||
      !selectedIds.length ||
      selectedIds.length > 500 ||
      selectedIds.some((id) => typeof id !== 'string' || id.length > 128)
    )
      return res.status(400).json({
        message: 'Select the collection items and destination libraries.',
      });
    try {
      return res.json(
        await checkCollection(
          req.params.id,
          [...new Set(libraryIds)] as string[],
          undefined,
          {
            kind: req.params.kind as 'tv' | 'music',
            selectedIds: [...new Set(selectedIds)] as string[],
          }
        )
      );
    } catch {
      return next({
        status: 503,
        message:
          'Cannot verify the selected collection. No automatic retry will create another copy.',
      });
    }
  }
);
router.delete(
  '/:kind/:id/server',
  isAuthenticated(Permission.ADMIN),
  async (req, res, next) => {
    const destinations = req.body?.destinations;
    if (
      !Array.isArray(destinations) ||
      !destinations.length ||
      destinations.length > 50 ||
      destinations.some(
        (entry) =>
          !entry ||
          typeof entry.libraryId !== 'string' ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(entry.libraryId) ||
          typeof entry.removalToken !== 'string' ||
          !/^[a-f0-9]{64}$/.test(entry.removalToken)
      ) ||
      new Set(destinations.map((entry) => entry.libraryId)).size !==
        destinations.length
    )
      return res
        .status(400)
        .json({ message: 'Confirm the collections to remove.' });
    try {
      return res.json(
        await checkCollection(req.params.id, undefined, destinations, {
          kind: req.params.kind as 'tv' | 'music',
        })
      );
    } catch {
      return next({
        status: 503,
        message: 'Cannot verify these collections for removal.',
      });
    }
  }
);
export default router;
