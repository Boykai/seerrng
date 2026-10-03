import {
  FavoriteSeriesAPI,
  getPlexWatchlistDiagnostic,
  PlexSavedItemAPI,
  PlexWatchlistError,
  runPlexWatchlistPhase,
} from '@server/api/mediaServerSavedItem';
import { getMetadataProvider } from '@server/api/metadata';
import { MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { getPlaybackMediaRootId } from '@server/lib/playbackMediaRoot';
import { getSettings } from '@server/lib/settings';
import {
  runUserSecurityMutationWithActor,
  runUserSecurityReadWithActor,
  UserMutationActorUnauthorizedError,
} from '@server/lib/userSecurityMutation';
import logger from '@server/logger';
import type { MediaServerSavedItemStatus } from '@server/models/MediaServerSavedItem';
import { getHostname } from '@server/utils/getHostname';
import { parsePositiveRouteId } from '@server/utils/routeId';
import { getRateLimitKey } from '@server/utils/security';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const routes = Router();
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nativeAccountActorOptions = {
  includeMediaServerCredentials: true,
} as const;
const serverAuthorityKey = (): string => {
  const settings = getSettings();
  const serverType = settings.main.mediaServerType;
  const config =
    serverType === MediaServerType.PLEX ? settings.plex : settings.jellyfin;
  return JSON.stringify({
    serverType,
    ip: config.ip,
    port: config.port,
    useSsl: config.useSsl,
    urlBase: 'urlBase' in config ? config.urlBase : undefined,
    serverId: 'serverId' in config ? config.serverId : config.machineId,
  });
};
const savedItemRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.user?.id ? `user:${req.user.id}` : getRateLimitKey(req),
  skip: () => process.env.NODE_ENV === 'test',
});

routes.all(
  '/:id/media-server-saved-item',
  savedItemRateLimit,
  async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'POST') return next();
    if (!req.user)
      return res.status(401).json({ message: 'Authentication required.' });
    const actorId = req.user.id;
    const id = parsePositiveRouteId(req.params.id, 1_000_000_000);
    if (!id) return res.status(400).json({ message: 'Invalid series ID.' });
    const updating = req.method === 'POST';
    // OpenAPI validation coerces the query to a boolean and inserts its default.
    // Also accept exact strings for direct router use; never coerce truthiness.
    const queryQuality: unknown = req.query.is4k;
    if (
      Object.keys(req.query).some((key) => key !== 'is4k') ||
      (updating && queryQuality !== undefined) ||
      (!updating &&
        queryQuality !== undefined &&
        typeof queryQuality !== 'boolean' &&
        queryQuality !== 'true' &&
        queryQuality !== 'false')
    )
      return res
        .status(400)
        .json({ message: 'Provide only a boolean quality selection.' });
    if (
      updating
        ? !record(req.body) ||
          Object.keys(req.body).some(
            (key) => key !== 'saved' && key !== 'is4k'
          ) ||
          typeof req.body.saved !== 'boolean' ||
          (req.body.is4k !== undefined && typeof req.body.is4k !== 'boolean')
        : req.body !== undefined &&
          (!record(req.body) || Object.keys(req.body).length !== 0)
    ) {
      return res.status(400).json({
        message:
          'Provide only the desired saved state and optional boolean quality selection.',
      });
    }
    const is4k = updating
      ? req.body.is4k === true
      : queryQuality === true || queryQuality === 'true';
    try {
      // Writes serialize account unlink/credential changes; reads do not hold the
      // mutation lock during catalog fetching. Both revalidate current authority.
      // Never use req.user's stale token or shared server credentials.
      const withAuthority = updating
        ? runUserSecurityMutationWithActor
        : runUserSecurityReadWithActor;
      const status = await withAuthority(
        actorId,
        actorId,
        [],
        async (user) => {
          if (user.id !== actorId)
            throw new UserMutationActorUnauthorizedError(
              'Account authority changed.'
            );
          const settings = getSettings();
          const serverType = settings.main.mediaServerType;
          const authorityKey = serverAuthorityKey();
          const account = {
            plexId: user.plexId,
            plexToken: user.plexToken,
            jellyfinUserId: user.jellyfinUserId,
            jellyfinAuthToken: user.jellyfinAuthToken,
          };
          const revalidateAuthority = async () => {
            const current = await runUserSecurityReadWithActor(
              actorId,
              actorId,
              [],
              async (actor) => actor,
              nativeAccountActorOptions
            );
            if (
              current.id !== actorId ||
              serverAuthorityKey() !== authorityKey ||
              current.plexId !== account.plexId ||
              current.plexToken !== account.plexToken ||
              current.jellyfinUserId !== account.jellyfinUserId ||
              current.jellyfinAuthToken !== account.jellyfinAuthToken
            )
              throw new UserMutationActorUnauthorizedError(
                'Account or media-server authority changed.'
              );
          };
          const base: MediaServerSavedItemStatus = {
            serverType,
            kind:
              serverType === MediaServerType.PLEX ? 'watchlist' : 'favorites',
            available: false,
          };
          if (serverType === MediaServerType.PLEX) {
            if (!user.plexToken || !user.plexId)
              return { ...base, reason: 'account-not-linked' as const };
            const series = await runPlexWatchlistPhase(
              'series-metadata',
              async () => {
                const metadata = await getMetadataProvider('tv');
                return metadata.getTvShow({ tvId: id });
              }
            );
            await revalidateAuthority();
            if (series.id !== id || !series.name?.trim())
              return { ...base, reason: 'series-not-found' as const };
            const provider = new PlexSavedItemAPI(account.plexToken!);
            await provider.verifyAccount(account.plexId!);
            const catalogId = await provider.resolveSeries(id, series.name);
            await revalidateAuthority();
            if (!catalogId)
              return { ...base, reason: 'series-not-found' as const };
            const saved = await provider.getSaved(catalogId);
            await revalidateAuthority();
            if (updating && saved !== req.body.saved) {
              await provider.setSaved(catalogId, req.body.saved);
              if (
                (await provider.getSaved(
                  catalogId,
                  'watchlist-confirmation'
                )) !== req.body.saved
              )
                throw new PlexWatchlistError(
                  'watchlist-confirmation',
                  'confirmation-mismatch'
                );
              await revalidateAuthority();
            }
            return {
              ...base,
              available: true,
              saved: updating ? req.body.saved : saved,
            };
          }
          if (
            serverType === MediaServerType.JELLYFIN ||
            serverType === MediaServerType.EMBY
          ) {
            if (!user.jellyfinUserId || !user.jellyfinAuthToken)
              return { ...base, reason: 'account-not-linked' as const };
            const media = await getRepository(Media).findOne({
              where: { tmdbId: id, mediaType: MediaType.TV },
            });
            await revalidateAuthority();
            if (
              !media ||
              media.tmdbId !== id ||
              media.mediaType !== MediaType.TV
            )
              return { ...base, reason: 'series-not-found' as const };
            const itemId = getPlaybackMediaRootId(media, serverType, is4k);
            if (!itemId)
              return { ...base, reason: 'series-not-found' as const };
            const provider = new FavoriteSeriesAPI(
              getHostname(settings.jellyfin),
              account.jellyfinAuthToken!,
              account.jellyfinUserId!,
              { serverType, trustedAccountPair: true }
            );
            await provider.verifyAccount();
            const saved = await provider.getSeriesSaved(itemId, id);
            await revalidateAuthority();
            const confirmed =
              updating && saved !== req.body.saved
                ? await provider.setSaved(itemId, req.body.saved)
                : saved;
            if (updating && saved !== req.body.saved)
              await revalidateAuthority();
            return { ...base, available: true, saved: confirmed };
          }
          return base;
        },
        nativeAccountActorOptions
      );
      if (updating && !status.available)
        return res.status(409).json({
          message:
            'This series cannot be saved to the linked media-server account.',
        });
      return res.json(status);
    } catch (error) {
      if (error instanceof UserMutationActorUnauthorizedError)
        return res
          .status(403)
          .json({ message: 'Account authority changed. Sign in again.' });
      // Provider errors can contain tokens/URLs. Never echo or log their details.
      const diagnostic = getPlexWatchlistDiagnostic(error);
      if (diagnostic) {
        logger.warn('Plex Watchlist operation failed.', {
          label: 'Plex Watchlist Diagnostics',
          ...diagnostic,
        });
      }
      return res.status(502).json({
        message:
          'The media-server saved state could not be loaded or updated. Please retry.',
        ...(diagnostic ? { diagnostic } : {}),
      });
    }
  }
);

export default routes;
