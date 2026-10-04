import {
  getMediaServerSeriesCollections,
  isMediaServerCollectionId,
  setMediaServerSeriesCollectionMembership,
} from '@server/api/mediaServerCollections';
import { PlexCollectionAuthorityError } from '@server/api/plexCollections';
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
import type {
  MediaServerCollectionContext,
  MediaServerCollectionsStatus,
} from '@server/models/MediaServerCollections';
import { parsePositiveRouteId } from '@server/utils/routeId';
import { getRateLimitKey } from '@server/utils/security';
import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

const routes = Router();
const collectionRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    req.user?.id ? `user:${req.user.id}` : getRateLimitKey(req),
  skip: () => process.env.NODE_ENV === 'test',
});
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

const handleCollections: RequestHandler = async (req, res) => {
  if (!req.user)
    return res.status(401).json({ message: 'Authentication required.' });
  const actorId = req.user.id;
  const id = parsePositiveRouteId(req.params.id, 1_000_000_000);
  if (!id) return res.status(400).json({ message: 'Invalid series ID.' });
  const updating = req.method === 'POST';
  // OpenAPI validates/coerces this value and inserts the false query default.
  // Exact strings remain valid for direct router use, without truthy coercion.
  const queryQuality: unknown = req.query.is4k;
  if (
    Object.keys(req.query).some((key) => key !== 'is4k') ||
    (updating && Object.keys(req.query).length !== 0) ||
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
          (key) => key !== 'member' && key !== 'is4k'
        ) ||
        typeof req.body.member !== 'boolean' ||
        (req.body.is4k !== undefined && typeof req.body.is4k !== 'boolean')
      : req.body !== undefined &&
        (!record(req.body) || Object.keys(req.body).length !== 0)
  )
    return res.status(400).json({
      message:
        'Provide only the desired membership and optional boolean quality selection.',
    });
  const collectionId = updating ? req.params.collectionId : undefined;
  if (
    updating &&
    !isMediaServerCollectionId(getSettings().main.mediaServerType, collectionId)
  )
    return res.status(400).json({ message: 'Invalid collection ID.' });
  const is4k = updating
    ? req.body.is4k === true
    : queryQuality === true || queryQuality === 'true';
  const member = updating ? (req.body.member as boolean) : undefined;
  try {
    const withAuthority = updating
      ? runUserSecurityMutationWithActor
      : runUserSecurityReadWithActor;
    const status = await withAuthority(
      actorId,
      actorId,
      [],
      async (actor): Promise<MediaServerCollectionsStatus> => {
        // The authority helper supplies the current persisted actor while writes
        // serialize unlink/credential changes. Ignore req.user's stale token fields.
        if (actor.id !== actorId)
          throw new UserMutationActorUnauthorizedError(
            'Account authority changed.'
          );
        const serverType = getSettings().main.mediaServerType;
        const unavailable = (
          reason: NonNullable<MediaServerCollectionsStatus['reason']>
        ): MediaServerCollectionsStatus => ({
          serverType,
          available: false,
          reason,
          collections: [],
        });
        if (
          ![
            MediaServerType.PLEX,
            MediaServerType.JELLYFIN,
            MediaServerType.EMBY,
          ].includes(serverType)
        )
          return unavailable('unsupported-server');
        if (
          serverType === MediaServerType.PLEX
            ? !actor.plexToken || !actor.plexId
            : !actor.jellyfinAuthToken || !actor.jellyfinUserId
        )
          return unavailable('account-not-linked');
        if (updating && !isMediaServerCollectionId(serverType, collectionId))
          return unavailable('not-authorized');
        const authorityKey = serverAuthorityKey();
        const account = {
          plexId: actor.plexId,
          plexToken: actor.plexToken,
          jellyfinUserId: actor.jellyfinUserId,
          jellyfinAuthToken: actor.jellyfinAuthToken,
        };
        const media = await getRepository(Media).findOne({
          where: { tmdbId: id, mediaType: MediaType.TV },
        });
        // Reads cannot hold the mutation lock throughout remote/database work.
        // Re-admit current actor authority after resolving the stored Series;
        // writes retain their outer mutation lock while this read revalidates it.
        const currentActor = await runUserSecurityReadWithActor(
          actorId,
          actorId,
          [],
          async (current) => current,
          nativeAccountActorOptions
        );
        if (
          serverAuthorityKey() !== authorityKey ||
          currentActor.id !== actorId ||
          currentActor.plexId !== account.plexId ||
          currentActor.plexToken !== account.plexToken ||
          currentActor.jellyfinUserId !== account.jellyfinUserId ||
          currentActor.jellyfinAuthToken !== account.jellyfinAuthToken
        )
          throw new UserMutationActorUnauthorizedError(
            'Account or media-server authority changed.'
          );
        const itemId = media && getPlaybackMediaRootId(media, serverType, is4k);
        if (
          !media ||
          media.tmdbId !== id ||
          media.mediaType !== MediaType.TV ||
          !itemId
        )
          return unavailable('series-not-found');
        const context: MediaServerCollectionContext = {
          user: {
            id: currentActor.id,
            plexId: currentActor.plexId,
            plexToken: currentActor.plexToken,
            jellyfinUserId: currentActor.jellyfinUserId,
            jellyfinAuthToken: currentActor.jellyfinAuthToken,
            jellyfinDeviceId: currentActor.jellyfinDeviceId,
          },
          tmdbId: id,
          itemId,
          is4k,
        };
        return updating
          ? setMediaServerSeriesCollectionMembership(
              context,
              collectionId as string,
              member as boolean
            )
          : getMediaServerSeriesCollections(context);
      },
      nativeAccountActorOptions
    );
    if (updating && !status.available)
      return res.status(409).json({
        message:
          'This series cannot be added to or removed from the selected media-server collection.',
      });
    return res.json(status);
  } catch (error) {
    if (error instanceof UserMutationActorUnauthorizedError)
      return res
        .status(403)
        .json({ message: 'Account authority changed. Sign in again.' });
    if (error instanceof PlexCollectionAuthorityError)
      return res.status(403).json({
        message:
          'The linked account cannot modify this media-server collection.',
      });
    // Native errors may contain credential-bearing URLs or request headers.
    // Never echo/log them or claim success after a partial provider failure.
    return res.status(502).json({
      message:
        'The media-server collections could not be loaded or updated. Please retry.',
    });
  }
};

routes.get(
  '/:id/media-server-collections',
  collectionRateLimit,
  handleCollections
);
routes.post(
  '/:id/media-server-collections/:collectionId',
  collectionRateLimit,
  handleCollections
);
export default routes;
