import AnilistAPI, { AnilistRateLimitedError } from '@server/api/anilist';
import SimklAPI from '@server/api/simkl';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import type { DiscoveryAccountProvider } from '@server/entity/DiscoveryAccount';
import ProviderTrackingAction from '@server/entity/ProviderTrackingAction';
import { runWithConfigurationAdmission } from '@server/lib/configurationAdmission';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { getSettings, MetadataProviderType } from '@server/lib/settings';
import { createHash } from 'node:crypto';
import {
  DiscoveryIntegrationError,
  getTraktClient,
  requireDiscoveryAccount,
} from './accounts';
import { invalidateAccountReads } from './cache';

export interface TrackingIntent {
  requestId: string;
  action: 'watched' | 'rating' | 'progress';
  value: number | boolean;
  mediaType?: 'movie' | 'tv';
  tmdbId?: number;
  anilistId?: number;
  episode?: { season: number; episode: number };
}
const id = (value: unknown): value is number =>
  Number.isSafeInteger(value) &&
  Number(value) > 0 &&
  Number(value) <= 2147483647;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function parseTrackingIntent(
  provider: DiscoveryAccountProvider,
  value: unknown
): TrackingIntent {
  const body = record(value);
  const fail = () => {
    throw new DiscoveryIntegrationError(
      400,
      'Choose a valid title, tracking action, and value.'
    );
  };
  if (
    Object.keys(body).some(
      (key) =>
        ![
          'requestId',
          'action',
          'value',
          'mediaType',
          'tmdbId',
          'anilistId',
          'episode',
        ].includes(key)
    ) ||
    typeof body.requestId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      body.requestId
    ) ||
    (body.action !== 'watched' &&
      body.action !== 'rating' &&
      body.action !== 'progress')
  )
    fail();
  const invalidNumber =
    typeof body.value !== 'number' ||
    !Number.isFinite(body.value) ||
    body.value < 0 ||
    body.value > (body.action === 'rating' ? 10 : 100000) ||
    (body.action === 'rating' && provider === 'anilist'
      ? !Number.isInteger(body.value * 10)
      : !Number.isSafeInteger(body.value));
  if (
    body.action === 'watched' ? typeof body.value !== 'boolean' : invalidNumber
  )
    fail();
  if (provider === 'anilist') {
    if (
      !id(body.anilistId) ||
      body.tmdbId !== undefined ||
      body.mediaType !== undefined ||
      body.episode !== undefined
    )
      fail();
    if (!isMediaCategoryEnabled('movie') && !isMediaCategoryEnabled('tv'))
      throw new DiscoveryIntegrationError(
        403,
        'Movie and series tracking is disabled.'
      );
  } else {
    if (
      !id(body.tmdbId) ||
      (body.mediaType !== 'movie' && body.mediaType !== 'tv') ||
      body.anilistId !== undefined ||
      body.action === 'progress'
    )
      fail();
    if (!isMediaCategoryEnabled(body.mediaType as 'movie' | 'tv'))
      throw new DiscoveryIntegrationError(
        403,
        'This media category is disabled.'
      );
    if (body.episode !== undefined) {
      const episode = record(body.episode);
      if (
        body.mediaType !== 'tv' ||
        body.action !== 'watched' ||
        Object.keys(episode).some(
          (key) => key !== 'season' && key !== 'episode'
        ) ||
        !Number.isSafeInteger(episode.season) ||
        Number(episode.season) < 0 ||
        Number(episode.season) > 10000 ||
        !id(episode.episode)
      )
        fail();
    }
  }
  return {
    requestId: String(body.requestId).toLowerCase(),
    action: body.action as TrackingIntent['action'],
    value: body.value as number | boolean,
    ...(provider === 'anilist'
      ? { anilistId: Number(body.anilistId) }
      : {
          mediaType: body.mediaType as 'movie' | 'tv',
          tmdbId: Number(body.tmdbId),
          ...(body.episode
            ? {
                episode: {
                  season: Number(record(body.episode).season),
                  episode: Number(record(body.episode).episode),
                },
              }
            : {}),
        }),
  };
}
/** Refresh outside personal write admission: token refresh owns the same user lock. */
export async function prepareTrackingAccount(
  userId: number,
  provider: DiscoveryAccountProvider
) {
  const account = await requireDiscoveryAccount(userId, provider);
  if (!account.allowWrites)
    throw new DiscoveryIntegrationError(
      403,
      'Enable watched-status and rating updates for this connection under Linked Accounts.'
    );
  if (provider === 'trakt')
    await (await getTraktClient(userId)).prepareAccessToken();
  return requireDiscoveryAccount(userId, provider);
}
export function publicTrackingAction(action: ProviderTrackingAction) {
  return {
    requestId: action.requestId,
    provider: action.provider,
    state: action.state,
    createdAt: action.createdAt,
    completedAt: action.completedAt,
  };
}
function validateAcknowledgement(response: unknown, allowEmpty = false) {
  if (
    allowEmpty &&
    (response === '' || response === null || response === undefined)
  )
    return;
  const body = record(response);
  const failures = record(body.not_found);
  if (
    Object.values(failures).some(
      (value) => Array.isArray(value) && value.length > 0
    )
  )
    throw new DiscoveryIntegrationError(
      409,
      'The provider could not identify this title. Check its catalog match before retrying.'
    );
  if (
    body.error ||
    body.errors ||
    !['added', 'updated', 'deleted'].some(
      (key) => Object.keys(record(body[key])).length > 0
    )
  )
    throw new DiscoveryIntegrationError(
      502,
      'The provider did not confirm the tracking action. Check your provider account before retrying.'
    );
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    Object.keys(body).length === 0
  )
    throw new DiscoveryIntegrationError(
      502,
      'The provider did not confirm the tracking action. Check your provider account before retrying.'
    );
}
/** Caller owns current browser/credential admission. Never automatically retry an uncertain write. */
export async function applyTrackingIntent(
  userId: number,
  provider: DiscoveryAccountProvider,
  intent: TrackingIntent,
  preparedToken: string
) {
  return runWithConfigurationAdmission('discoveryIntegrations', async () => {
    intent = parseTrackingIntent(provider, intent);
    const account = await requireDiscoveryAccount(userId, provider);
    if (!account.allowWrites || account.accessToken !== preparedToken)
      throw new DiscoveryIntegrationError(
        409,
        'Your account connection or write consent changed. Refresh before updating tracking.'
      );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          provider,
          account.clientId,
          account.providerUserId,
          intent,
        ])
      )
      .digest('hex');
    const repo = getRepository(ProviderTrackingAction);
    const existing = await repo.findOneBy({
      userId,
      requestId: intent.requestId,
    });
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new DiscoveryIntegrationError(
          409,
          'This action identifier was already used for another operation.'
        );
      if (existing.state !== 'succeeded')
        throw new DiscoveryIntegrationError(
          409,
          'This action has an uncertain outcome. Check your provider account before submitting a new action.'
        );
      return publicTrackingAction(existing);
    }
    const uncertain = await repo.findOneBy({
      userId,
      provider,
      fingerprint,
      state: 'unknown',
    });
    if (uncertain)
      throw new DiscoveryIntegrationError(
        409,
        'A previous matching action has an uncertain outcome. Check your provider account before making this change again.'
      );

    // Resolve external series identity and validate native AniList metadata
    // before recording a pending mutation. Failed reads never become unknown writes.
    let anilistApi: AnilistAPI | undefined;
    let anilistMedia: Awaited<ReturnType<AnilistAPI['getMedia']>>;
    let tvdbShowId: number | undefined;
    let useTvdbAnimeSeasons = false;
    if (intent.episode) {
      let show: Awaited<ReturnType<TheMovieDb['getTvShow']>>;
      try {
        show = await new TheMovieDb().getTvShow({ tvId: intent.tmdbId! });
      } catch {
        throw new DiscoveryIntegrationError(
          502,
          'The series identity could not be confirmed. Try the episode update again.'
        );
      }
      if (show.id !== intent.tmdbId)
        throw new DiscoveryIntegrationError(
          409,
          'The series identity changed. Refresh the library before updating an episode.'
        );
      tvdbShowId = id(show.external_ids?.tvdb_id)
        ? Number(show.external_ids.tvdb_id)
        : undefined;
      const isAnime = show.keywords.results.some(
        (keyword) => keyword.id === ANIME_KEYWORD_ID
      );
      const settings = getSettings();
      const metadataProvider = isAnime
        ? settings.metadataSettings.anime
        : settings.metadataSettings.tv;
      useTvdbAnimeSeasons =
        isAnime &&
        tvdbShowId !== undefined &&
        metadataProvider === MetadataProviderType.TVDB;
    }
    if (provider === 'anilist') {
      anilistApi = new AnilistAPI({ accessToken: account.accessToken });
      anilistMedia = await anilistApi.getMedia(intent.anilistId!);
      if (
        !anilistMedia ||
        (anilistMedia.format === 'MOVIE'
          ? !isMediaCategoryEnabled('movie')
          : !isMediaCategoryEnabled('tv'))
      )
        throw new DiscoveryIntegrationError(
          409,
          'This anime title is unavailable or its category is disabled.'
        );
      if (
        intent.action === 'progress' &&
        anilistMedia.episodes &&
        Number(intent.value) > anilistMedia.episodes
      )
        throw new DiscoveryIntegrationError(
          400,
          'Episode progress exceeds this title’s episode count.'
        );
    }
    const action = await repo.save(
      repo.create({
        userId,
        requestId: intent.requestId,
        provider,
        fingerprint,
        intent: JSON.stringify(intent),
        state: 'pending',
        createdAt: new Date(),
      })
    );
    try {
      if (provider === 'anilist') {
        const media = anilistMedia!;
        const options = {
          mediaId: intent.anilistId!,
          ...(intent.action === 'rating'
            ? { scoreRaw: Math.round(Number(intent.value) * 10) }
            : intent.action === 'progress'
              ? {
                  progress: Number(intent.value),
                  status:
                    Number(intent.value) === 0
                      ? ('PLANNING' as const)
                      : media.episodes && Number(intent.value) >= media.episodes
                        ? ('COMPLETED' as const)
                        : ('CURRENT' as const),
                }
              : {
                  status: intent.value
                    ? ('COMPLETED' as const)
                    : ('PLANNING' as const),
                  ...(intent.value
                    ? media.episodes
                      ? { progress: media.episodes }
                      : {}
                    : { progress: 0 }),
                }),
        };
        const response = await anilistApi!.saveMediaListEntry(options);
        if (!id(response?.id))
          throw new DiscoveryIntegrationError(
            502,
            'AniList did not confirm the list update.'
          );
      } else {
        // Tokens were refreshed before admission. This client cannot acquire the user lock recursively.
        const api =
          provider === 'trakt'
            ? new TraktAPI({
                ...getSettings().discoveryIntegrations.trakt,
                accessToken: account.accessToken,
                expiresAt: account.expiresAt ?? 0,
              })
            : new SimklAPI({
                clientId: account.clientId,
                accessToken: account.accessToken,
              });
        let response: unknown;
        if (intent.action === 'rating')
          response =
            Number(intent.value) === 0
              ? await api.removeRating(intent.mediaType!, intent.tmdbId!)
              : api instanceof TraktAPI
                ? await api.addRating(
                    intent.mediaType!,
                    intent.tmdbId!,
                    Number(intent.value)
                  )
                : await api.setRating(
                    intent.mediaType!,
                    intent.tmdbId!,
                    Number(intent.value)
                  );
        else if (intent.episode)
          response =
            api instanceof TraktAPI
              ? intent.value
                ? await api.addEpisodeToHistory(
                    intent.tmdbId!,
                    intent.episode.season,
                    intent.episode.episode,
                    tvdbShowId
                  )
                : await api.removeEpisodeFromHistory(
                    intent.tmdbId!,
                    intent.episode.season,
                    intent.episode.episode,
                    tvdbShowId
                  )
              : await api.setEpisodeHistory(
                  {
                    tmdb: intent.tmdbId!,
                    ...(tvdbShowId ? { tvdb: tvdbShowId } : {}),
                  },
                  intent.episode.season,
                  intent.episode.episode,
                  Boolean(intent.value),
                  useTvdbAnimeSeasons
                );
        else
          response =
            api instanceof TraktAPI
              ? intent.value
                ? await api.addToHistory(intent.mediaType!, intent.tmdbId!)
                : await api.removeFromHistory(intent.mediaType!, intent.tmdbId!)
              : intent.value
                ? await api.addHistory(intent.mediaType!, intent.tmdbId!)
                : await api.removeHistory(intent.mediaType!, intent.tmdbId!);
        validateAcknowledgement(
          response,
          provider === 'simkl' &&
            ((intent.action === 'watched' && intent.value === false) ||
              (intent.action === 'rating' && intent.value === 0))
        );
      }
      action.state = 'succeeded';
      action.completedAt = new Date();
      await repo.save(action);
      return publicTrackingAction(action);
    } catch (error) {
      if (error instanceof AnilistRateLimitedError && !error.requestSent) {
        // The shared AniList limiter refused the write before sending it, so
        // nothing changed and the same action can be tried again later.
        await repo.remove(action);
        throw error;
      }
      action.state = 'unknown';
      action.completedAt = new Date();
      await repo.save(action);
      throw error;
    } finally {
      invalidateAccountReads(account);
    }
  });
}
