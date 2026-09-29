import AnilistAPI from '@server/api/anilist';
import SimklAPI from '@server/api/simkl';
import TheMovieDb from '@server/api/themoviedb';
import TraktAPI from '@server/api/trakt';
import { getRepository } from '@server/datasource';
import DiscoveryAccount from '@server/entity/DiscoveryAccount';
import ProviderTrackingAction from '@server/entity/ProviderTrackingAction';
import { runWithConfigurationAdmission } from '@server/lib/configurationAdmission';
import {
  DiscoveryIntegrationError,
  parseDiscoveryProvider,
  publicDiscoveryAccount,
  requireDiscoveryAccount,
  saveDiscoveryAccount,
} from '@server/lib/discoveryIntegrations/accounts';
import {
  exportCuratedIdentityPack,
  importCuratedIdentityMappingPack,
  listCuratedIdentityPacks,
  MAX_CURATED_IDENTITY_PACK_BYTES,
  parseCuratedIdentityMappingPack,
  removeCuratedIdentityPack,
} from '@server/lib/discoveryIntegrations/curatedIdentityPacks';
import {
  parseEpisodeWatchStateRequest,
  providerEpisodeWatchState,
} from '@server/lib/discoveryIntegrations/episodeWatchState';
import { discoveryFeed } from '@server/lib/discoveryIntegrations/feeds';
import {
  handleDiscoveryIntegration,
  requireDiscoveryBrowserSession,
  runPersonalDiscoveryMutation,
} from '@server/lib/discoveryIntegrations/http';
import {
  exportPersonalIdentityMappingPack,
  importPersonalIdentityMappingPack,
  parsePersonalIdentityMappingPack,
  parsePersonalIdentitySource,
  removePersonalIdentityMapping,
  savePersonalIdentityMapping,
} from '@server/lib/discoveryIntegrations/identityMappings';
import {
  personalProviderLibrary,
  type LibraryShelf,
} from '@server/lib/discoveryIntegrations/library';
import {
  getNativeLibraryConnection,
  MAX_NATIVE_LIBRARY_CURSOR,
  personalMediaServerLibrary,
  type NativeLibrarySource,
} from '@server/lib/discoveryIntegrations/mediaServerLibrary';
import {
  applyTrackingIntent,
  parseTrackingIntent,
  prepareTrackingAccount,
  publicTrackingAction,
} from '@server/lib/discoveryIntegrations/tracking';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { isAuthenticated } from '@server/middleware/auth';
import {
  authorizedMutation,
  authorizedRouteAccess,
} from '@server/middleware/authorizedMutation';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';

const router = Router();
router.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});
const handle = handleDiscoveryIntegration;
const personalMutation = runPersonalDiscoveryMutation;
const identityMappingRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? 'anonymous'}`,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.E2E_TESTS === 'true',
});
const identityMappingPackRateLimit = rateLimit({
  windowMs: 5 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? 'anonymous'}`,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.E2E_TESTS === 'true',
});
const episodeWatchStateRateLimit = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? 'anonymous'}`,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.E2E_TESTS === 'true',
});
const curatedIdentityPackRateLimit = rateLimit({
  windowMs: 5 * 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user?.id ?? 'anonymous'}`,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.E2E_TESTS === 'true',
});

async function requireOwnedIdentity(
  userId: number,
  identity: string
): Promise<void> {
  const source = parsePersonalIdentitySource(identity);
  // AniList and MDBList catalogs are browsable without linking a personal
  // account. Their repairs remain private to this user, like library matches.
  if (source === 'anilist' || source === 'mdblist') return;
  if (source === 'trakt' || source === 'simkl') {
    await requireDiscoveryAccount(userId, source);
    return;
  }
  const connection = await getNativeLibraryConnection(userId);
  if (!connection?.connected || connection.provider !== source)
    throw new DiscoveryIntegrationError(
      409,
      'Connect this media server before matching its library titles.'
    );
}

router.put(
  '/mappings',
  identityMappingRateLimit,
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const body = req.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !['identity', 'tmdbId', 'mediaType'].includes(key)
      ) ||
      typeof body.identity !== 'string' ||
      !Number.isSafeInteger(body.tmdbId) ||
      (body.mediaType !== 'movie' && body.mediaType !== 'tv')
    )
      throw new DiscoveryIntegrationError(400, 'Choose a valid catalog match.');

    await requireOwnedIdentity(req.user!.id, body.identity);
    if (!isMediaCategoryEnabled(body.mediaType))
      throw new DiscoveryIntegrationError(
        403,
        'This media category is disabled.'
      );
    try {
      const tmdb = new TheMovieDb();
      const target =
        body.mediaType === 'movie'
          ? await tmdb.getMovie({ movieId: body.tmdbId })
          : await tmdb.getTvShow({ tvId: body.tmdbId });
      if (target.id !== body.tmdbId)
        throw new Error('TMDB returned a different title.');
    } catch {
      throw new DiscoveryIntegrationError(
        502,
        'The catalog could not confirm this match. Search again or try later.'
      );
    }

    res.json(
      await personalMutation(req, () =>
        savePersonalIdentityMapping(
          req.user!.id,
          body.identity,
          body.tmdbId,
          body.mediaType
        )
      )
    );
  })
);
router.delete(
  '/mappings/:identity',
  identityMappingRateLimit,
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const identity = String(req.params.identity);
    await requireOwnedIdentity(req.user!.id, identity);
    res.json(
      await personalMutation(req, () =>
        removePersonalIdentityMapping(req.user!.id, identity)
      )
    );
  })
);
router.get(
  '/mappings/pack',
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    res.json(await exportPersonalIdentityMappingPack(req.user!.id));
  })
);
router.post(
  '/mappings/pack',
  identityMappingPackRateLimit,
  express.text({ type: 'text/plain', limit: '5mb' }),
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    if (typeof req.body !== 'string')
      throw new DiscoveryIntegrationError(
        400,
        'Select a valid title-match file.'
      );
    let pack: unknown;
    try {
      pack = JSON.parse(req.body);
    } catch {
      throw new DiscoveryIntegrationError(
        400,
        'This title-match file is not valid JSON.'
      );
    }
    const validatedPack = parsePersonalIdentityMappingPack(pack);
    res.json(
      await personalMutation(req, () =>
        importPersonalIdentityMappingPack(req.user!.id, validatedPack)
      )
    );
  })
);
router.get(
  '/mappings/packs',
  isAuthenticated(Permission.ADMIN),
  authorizedRouteAccess(Permission.ADMIN),
  handle(async (_req, res) => {
    res.json({ packs: await listCuratedIdentityPacks() });
  })
);
router.get(
  '/mappings/packs/:packId',
  isAuthenticated(Permission.ADMIN),
  authorizedRouteAccess(Permission.ADMIN),
  handle(async (req, res) => {
    res.json(await exportCuratedIdentityPack(req.params.packId));
  })
);
router.post(
  '/mappings/packs',
  curatedIdentityPackRateLimit,
  isAuthenticated(Permission.ADMIN),
  express.text({
    type: 'text/plain',
    limit: MAX_CURATED_IDENTITY_PACK_BYTES,
  }),
  authorizedMutation(
    Permission.ADMIN,
    handle(async (req, res) => {
      requireDiscoveryBrowserSession(req);
      if (typeof req.body !== 'string')
        throw new DiscoveryIntegrationError(
          400,
          'Select a valid shared title-match file.'
        );
      let value: unknown;
      try {
        value = JSON.parse(req.body);
      } catch {
        throw new DiscoveryIntegrationError(
          400,
          'This shared title-match file is not valid JSON.'
        );
      }
      const pack = parseCuratedIdentityMappingPack(value);
      res.json(await importCuratedIdentityMappingPack(pack));
    })
  )
);
router.delete(
  '/mappings/packs/:packId',
  curatedIdentityPackRateLimit,
  isAuthenticated(Permission.ADMIN),
  authorizedMutation(
    Permission.ADMIN,
    handle(async (req, res) => {
      requireDiscoveryBrowserSession(req);
      res.json(await removeCuratedIdentityPack(req.params.packId));
    })
  )
);
function publicConfiguration() {
  const config = getSettings().discoveryIntegrations;
  return {
    trakt: {
      clientId: config.trakt.clientId,
      configured: !!(config.trakt.clientId && config.trakt.clientSecret),
    },
    anilist: {
      clientId: config.anilist.clientId,
      configured: !!(config.anilist.clientId && config.anilist.clientSecret),
    },
    simkl: {
      clientId: config.simkl.clientId,
      configured: !!config.simkl.clientId,
    },
    mdblist: { configured: !!config.mdblist.apiKey },
  };
}
router.get('/configuration', (_req, res) => res.json(publicConfiguration()));
router.put(
  '/configuration',
  authorizedMutation(
    Permission.ADMIN,
    handle(async (req, res) => {
      const body = req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new DiscoveryIntegrationError(
          400,
          'Invalid integration settings.'
        );
      const allowed = {
        trakt: ['clientId', 'clientSecret'],
        anilist: ['clientId', 'clientSecret'],
        simkl: ['clientId'],
        mdblist: ['apiKey'],
      };
      for (const [provider, fields] of Object.entries(body)) {
        if (
          !(provider in allowed) ||
          !fields ||
          typeof fields !== 'object' ||
          Array.isArray(fields)
        )
          throw new DiscoveryIntegrationError(
            400,
            'Unknown integration setting.'
          );
        for (const [key, value] of Object.entries(fields)) {
          if (
            !(allowed[provider as keyof typeof allowed] as string[]).includes(
              key
            ) ||
            typeof value !== 'string' ||
            value.length > 4096
          )
            throw new DiscoveryIntegrationError(
              400,
              'Invalid integration credential.'
            );
        }
      }
      await runWithConfigurationAdmission('discoveryIntegrations', () =>
        getSettings().persistSection('discoveryIntegrations', (current) => ({
          trakt: { ...current.trakt, ...body.trakt },
          anilist: { ...current.anilist, ...body.anilist },
          simkl: { ...current.simkl, ...body.simkl },
          mdblist: { ...current.mdblist, ...body.mdblist },
        }))
      );
      res.json(publicConfiguration());
    })
  )
);
router.get(
  '/accounts',
  handle(async (req, res) => {
    const accounts = await getRepository(DiscoveryAccount).findBy({
      userId: req.user!.id,
    });
    res.json({
      accounts: accounts
        .filter(
          (account) =>
            account.clientId ===
            getSettings().discoveryIntegrations[account.provider].clientId
        )
        .map(publicDiscoveryAccount),
      mediaServer: await getNativeLibraryConnection(req.user!.id),
    });
  })
);
router.delete(
  '/accounts/:provider',
  handle(async (req, res) => {
    const provider = parseDiscoveryProvider(req.params.provider);
    await personalMutation(req, () =>
      getRepository(DiscoveryAccount).delete({ userId: req.user!.id, provider })
    );
    if (provider !== 'anilist' && req.session.discoveryAuth)
      delete req.session.discoveryAuth[provider];
    res.status(204).end();
  })
);
router.put(
  '/accounts/:provider/preferences',
  handle(async (req, res) => {
    const provider = parseDiscoveryProvider(req.params.provider);
    if (typeof req.body?.allowWrites !== 'boolean')
      throw new DiscoveryIntegrationError(
        400,
        'Choose whether tracking writes are allowed.'
      );
    await personalMutation(req, async () => {
      const result = await getRepository(DiscoveryAccount).update(
        { userId: req.user!.id, provider },
        { allowWrites: req.body.allowWrites }
      );
      if (!result.affected)
        throw new DiscoveryIntegrationError(404, 'Account is not connected.');
    });
    res.status(204).end();
  })
);
router.post(
  '/accounts/:provider/connect',
  handle(async (req, res) => {
    const provider = parseDiscoveryProvider(req.params.provider);
    await personalMutation(req, () =>
      runWithConfigurationAdmission('discoveryIntegrations', async () => {
        const config = getSettings().discoveryIntegrations[provider];
        if (
          !config.clientId ||
          ('clientSecret' in config && !config.clientSecret)
        )
          throw new DiscoveryIntegrationError(
            409,
            'Ask your administrator to configure this integration first.'
          );
        if (provider === 'anilist')
          return res.json({
            verificationUrl: AnilistAPI.buildAuthorizeUrl(config.clientId),
          });
        const pending = req.session.discoveryAuth?.[provider];
        if (
          pending &&
          pending.expiresAt > Date.now() &&
          pending.clientId === config.clientId
        ) {
          return res.json({
            userCode: pending.userCode,
            verificationUrl:
              provider === 'trakt'
                ? 'https://trakt.tv/activate'
                : 'https://simkl.com/pin/',
            interval: pending.interval,
            expiresIn: Math.ceil((pending.expiresAt - Date.now()) / 1000),
          });
        }
        const result =
          provider === 'trakt'
            ? await new TraktAPI(
                getSettings().discoveryIntegrations.trakt
              ).requestDeviceCode()
            : await new SimklAPI({
                clientId: config.clientId,
              }).requestPinCode();
        const code = 'device_code' in result ? result.device_code : undefined;
        const userCode = result.user_code;
        if (!userCode || (provider === 'trakt' && !code))
          throw new DiscoveryIntegrationError(
            502,
            'Provider returned an invalid connection code.'
          );
        const interval = Math.max(5, Math.min(60, result.interval ?? 5));
        const expiresIn = Math.max(
          30,
          Math.min(1800, result.expires_in ?? 600)
        );
        req.session.discoveryAuth ??= {};
        req.session.discoveryAuth[provider] = {
          code: code ?? userCode,
          userCode,
          clientId: config.clientId,
          interval,
          expiresAt: Date.now() + expiresIn * 1000,
          nextPollAt: Date.now() + interval * 1000,
        };
        res.json({
          userCode,
          verificationUrl:
            provider === 'trakt'
              ? 'https://trakt.tv/activate'
              : 'https://simkl.com/pin/',
          interval,
          expiresIn,
        });
      })
    );
  })
);
router.post(
  '/accounts/:provider/complete',
  handle(async (req, res) => {
    const provider = parseDiscoveryProvider(req.params.provider);
    await personalMutation(req, () =>
      runWithConfigurationAdmission('discoveryIntegrations', async () => {
        const config = getSettings().discoveryIntegrations[provider];
        if (provider === 'anilist') {
          if (
            typeof req.body?.code !== 'string' ||
            !req.body.code.trim() ||
            req.body.code.length > 4096
          )
            throw new DiscoveryIntegrationError(
              400,
              'Enter the authorization code provided by AniList.'
            );
          const credentials = getSettings().discoveryIntegrations.anilist;
          if (!credentials.clientId || !credentials.clientSecret)
            throw new DiscoveryIntegrationError(
              409,
              'AniList is not configured.'
            );
          const tokens = await AnilistAPI.exchangePinCode(
            credentials.clientId,
            credentials.clientSecret,
            req.body.code.trim()
          );
          const viewer = await new AnilistAPI(tokens).getViewer();
          const account = await saveDiscoveryAccount(
            req.user!.id,
            provider,
            tokens,
            { username: viewer.name, providerUserId: String(viewer.id) }
          );
          return res.json({
            status: 'authorized',
            account: publicDiscoveryAccount(account),
          });
        }
        const pending = req.session.discoveryAuth?.[provider];
        if (
          !pending ||
          pending.expiresAt <= Date.now() ||
          pending.clientId !== config.clientId
        ) {
          if (req.session.discoveryAuth)
            delete req.session.discoveryAuth[provider];
          throw new DiscoveryIntegrationError(
            409,
            'Connection expired. Start again.'
          );
        }
        if (pending.nextPollAt > Date.now())
          return res
            .status(202)
            .json({ status: 'pending', interval: pending.interval });
        pending.nextPollAt = Date.now() + pending.interval * 1000;
        if (provider === 'trakt') {
          const result = await new TraktAPI(
            getSettings().discoveryIntegrations.trakt
          ).pollForToken(pending.code);
          if (result.status !== 'authorized') {
            if (result.status === 'slow_down')
              pending.interval = Math.min(60, pending.interval + 5);
            if (result.status !== 'pending' && result.status !== 'slow_down')
              delete req.session.discoveryAuth![provider];
            return res
              .status(202)
              .json({ status: result.status, interval: pending.interval });
          }
          const identity = await new TraktAPI({
            ...getSettings().discoveryIntegrations.trakt,
            accessToken: result.tokens.access_token,
            refreshToken: result.tokens.refresh_token,
            expiresAt: result.tokens.expiresAt,
          }).getUserSettings();
          const account = await saveDiscoveryAccount(
            req.user!.id,
            provider,
            {
              accessToken: result.tokens.access_token,
              refreshToken: result.tokens.refresh_token,
              expiresAt: result.tokens.expiresAt,
            },
            {
              username: identity.username,
              providerUserId: String(identity.traktUserId),
            }
          );
          delete req.session.discoveryAuth![provider];
          return res.json({
            status: 'authorized',
            account: publicDiscoveryAccount(account),
          });
        }
        const result = await new SimklAPI({
          clientId: config.clientId,
        }).pollPinToken(pending.userCode);
        const accessToken = result.access_token ?? result.token;
        if (!accessToken)
          return res
            .status(202)
            .json({ status: 'pending', interval: pending.interval });
        const identity = await new SimklAPI({
          clientId: config.clientId,
          accessToken,
        }).getUserSettings();
        const account = await saveDiscoveryAccount(
          req.user!.id,
          provider,
          { accessToken },
          {
            username: identity.user?.username ?? identity.user?.name ?? '',
            providerUserId: String(
              identity.user?.id ?? identity.account?.id ?? ''
            ),
          }
        );
        delete req.session.discoveryAuth![provider];
        return res.json({
          status: 'authorized',
          account: publicDiscoveryAccount(account),
        });
      })
    );
  })
);
router.get(
  '/feeds/:provider/:feed',
  handle(async (req, res) => {
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    if (req.query.list !== undefined && typeof req.query.list !== 'string')
      throw new DiscoveryIntegrationError(400, 'Invalid list reference.');
    res.json(
      await discoveryFeed(
        req.user!.id,
        String(req.params.provider),
        String(req.params.feed),
        page,
        req.query.list as string | undefined
      )
    );
  })
);
router.get(
  '/library/:provider',
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const source = String(req.params.provider);
    if (source === 'plex' || source === 'jellyfin' || source === 'emby') {
      const shelf = req.query.shelf ?? 'all';
      const rawPage = req.query.page;
      const page =
        rawPage === undefined
          ? 1
          : typeof rawPage === 'number' && Number.isSafeInteger(rawPage)
            ? rawPage
            : typeof rawPage === 'string' && /^[1-9]\d{0,2}$/.test(rawPage)
              ? Number(rawPage)
              : NaN;
      const rawCursor = req.query.cursor;
      const cursor =
        rawCursor === undefined
          ? undefined
          : typeof rawCursor === 'number' && Number.isSafeInteger(rawCursor)
            ? rawCursor
            : typeof rawCursor === 'string' && /^\d{1,6}$/.test(rawCursor)
              ? Number(rawCursor)
              : NaN;
      const libraryId = req.query.libraryId;
      if (
        typeof shelf !== 'string' ||
        !['all', 'watched', 'unwatched', 'in-progress'].includes(shelf) ||
        !Number.isSafeInteger(page) ||
        page > 500 ||
        (cursor !== undefined &&
          (!Number.isSafeInteger(cursor) ||
            cursor < 0 ||
            cursor > MAX_NATIVE_LIBRARY_CURSOR)) ||
        (libraryId !== undefined && typeof libraryId !== 'string') ||
        req.query.mediaType !== undefined
      )
        throw new DiscoveryIntegrationError(
          400,
          'Choose a valid media server library and shelf.'
        );
      res.json(
        await personalMediaServerLibrary(
          req.user!.id,
          source as NativeLibrarySource,
          shelf as LibraryShelf,
          page,
          libraryId as string | undefined,
          cursor
        )
      );
      return;
    }
    const provider = parseDiscoveryProvider(req.params.provider);
    const shelf = req.query.shelf ?? (provider === 'trakt' ? 'watched' : 'all');
    const rawPage = req.query.page;
    const page =
      rawPage === undefined
        ? 1
        : typeof rawPage === 'number' && Number.isSafeInteger(rawPage)
          ? rawPage
          : typeof rawPage === 'string' && /^[1-9]\d{0,2}$/.test(rawPage)
            ? Number(rawPage)
            : NaN;
    const mediaType = req.query.mediaType;
    if (
      typeof shelf !== 'string' ||
      ![
        'all',
        'watchlist',
        'watched',
        'in-progress',
        'completed',
        'rated',
      ].includes(shelf) ||
      !Number.isSafeInteger(page) ||
      page > 500 ||
      (mediaType !== undefined && mediaType !== 'movie' && mediaType !== 'tv')
    )
      throw new DiscoveryIntegrationError(
        400,
        'Choose a valid library shelf and media type.'
      );
    res.json(
      await personalProviderLibrary(
        req.user!.id,
        provider,
        shelf as LibraryShelf,
        page,
        mediaType as 'movie' | 'tv' | undefined
      )
    );
  })
);
router.get(
  '/tracking/:provider/episodes',
  episodeWatchStateRateLimit,
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const provider = String(req.params.provider);
    if (provider !== 'trakt' && provider !== 'simkl')
      throw new DiscoveryIntegrationError(
        400,
        'Choose Trakt or Simkl for episode watch status.'
      );
    const request = parseEpisodeWatchStateRequest({
      sourceId: req.query.sourceId,
      tmdbId:
        typeof req.query.tmdbId === 'string' ||
        typeof req.query.tmdbId === 'number'
          ? Number(req.query.tmdbId)
          : req.query.tmdbId,
      season:
        typeof req.query.season === 'string' ||
        typeof req.query.season === 'number'
          ? Number(req.query.season)
          : req.query.season,
    });
    res.json(await providerEpisodeWatchState(req.user!.id, provider, request));
  })
);
router.post(
  '/tracking/:provider',
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const provider = parseDiscoveryProvider(req.params.provider);
    const intent = parseTrackingIntent(provider, req.body);
    const prepared = await prepareTrackingAccount(req.user!.id, provider);
    const result = await personalMutation(req, () =>
      applyTrackingIntent(req.user!.id, provider, intent, prepared.accessToken)
    );
    res.json(result);
  })
);
router.get(
  '/tracking/actions/:requestId',
  handle(async (req, res) => {
    requireDiscoveryBrowserSession(req);
    const action = await getRepository(ProviderTrackingAction).findOneBy({
      userId: req.user!.id,
      requestId: String(req.params.requestId),
    });
    if (!action)
      throw new DiscoveryIntegrationError(404, 'Tracking action not found.');
    res.json(publicTrackingAction(action));
  })
);
export default router;
