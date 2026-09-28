import ProwlarrAPI from '@server/api/prowlarr';
import {
  MEDIA_CATEGORY_KEYS,
  type MediaCategoryKey,
} from '@server/constants/mediaCategories';
import type { ProwlarrSearchResultsResponse } from '@server/interfaces/api/prowlarrInterfaces';
import { sanitizeProwlarrSearchResource } from '@server/lib/prowlarr';
import { getSettings } from '@server/lib/settings';
import {
  getRateLimitKey,
  hasAsciiControlCharacters,
} from '@server/utils/security';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';

const indexerSearchRoutes = Router();
const SEARCH_RESULT_LIMIT = 50;
const MAX_SEARCH_OFFSET = 2_000;

const searchRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 12,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getRateLimitKey,
  skip: () =>
    process.env.NODE_ENV === 'test' || process.env.E2E_TESTS === 'true',
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const parseCategory = (value: unknown): MediaCategoryKey | undefined =>
  typeof value === 'string' &&
  (MEDIA_CATEGORY_KEYS as readonly string[]).includes(value)
    ? (value as MediaCategoryKey)
    : undefined;

const parseQuery = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const query = value.trim();
  return query.length >= 2 &&
    query.length <= 256 &&
    !hasAsciiControlCharacters(query)
    ? query
    : undefined;
};

const parseOffset = (value: unknown): number | undefined =>
  value === undefined || value === 0
    ? 0
    : typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= MAX_SEARCH_OFFSET &&
        value % SEARCH_RESULT_LIMIT === 0
      ? value
      : undefined;

indexerSearchRoutes.get('/configuration', (_req, res) => {
  const settings = getSettings().prowlarr;
  return res.status(200).json({
    configured: Boolean(settings.hostname && settings.apiKey),
    categories: MEDIA_CATEGORY_KEYS.map((category) => ({
      category,
      categoryIds: settings.categoryMappings[category],
    })),
  });
});

indexerSearchRoutes.post('/search', searchRateLimit, async (req, res) => {
  if (!isRecord(req.body)) {
    return res.status(400).json({ error: 'Search request must be an object.' });
  }
  const category = parseCategory(req.body.category);
  if (!category) {
    return res
      .status(400)
      .json({ error: 'Choose a supported media category.' });
  }
  const query = parseQuery(req.body.query);
  if (!query) {
    return res
      .status(400)
      .json({ error: 'Search text must contain 2 to 256 characters.' });
  }
  const offset = parseOffset(req.body.offset);
  if (offset === undefined) {
    return res.status(400).json({ error: 'Search result offset is invalid.' });
  }

  const settings = getSettings().prowlarr;
  if (!settings.hostname || !settings.apiKey) {
    return res.status(409).json({ error: 'Prowlarr is not configured.' });
  }
  const categoryIds = settings.categoryMappings[category].filter(
    (id) => Number.isSafeInteger(id) && id > 0
  );
  if (categoryIds.length === 0) {
    return res.status(409).json({
      error: 'No Prowlarr categories are configured for this medium.',
    });
  }

  try {
    const rawResults = await new ProwlarrAPI(settings).search(
      query,
      categoryIds,
      SEARCH_RESULT_LIMIT,
      offset
    );
    const results = Array.isArray(rawResults)
      ? rawResults
          .filter(isRecord)
          .slice(0, SEARCH_RESULT_LIMIT)
          .map(sanitizeProwlarrSearchResource)
      : [];
    const response: ProwlarrSearchResultsResponse = {
      category,
      query,
      offset,
      limit: SEARCH_RESULT_LIMIT,
      results,
      hasMore:
        offset < MAX_SEARCH_OFFSET && results.length === SEARCH_RESULT_LIMIT,
    };
    return res.status(200).json(response);
  } catch {
    return res.status(502).json({ error: 'Prowlarr search failed.' });
  }
});

export default indexerSearchRoutes;
