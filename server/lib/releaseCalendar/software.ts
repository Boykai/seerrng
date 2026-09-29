import QuestarrNGAPI from '@server/api/software/questarrng';
import ROMarrNGAPI from '@server/api/software/romarrng';
import type { SoftwareCatalogGame } from '@server/api/software/types';
import { getRepository } from '@server/datasource';
import SoftwareRequest, {
  type SoftwareRequestCategory,
  type SoftwareRequestProvider,
} from '@server/entity/SoftwareRequest';
import { isMediaCategoryEnabled } from '@server/lib/mediaCategories';
import { getSettings } from '@server/lib/settings';
import { mapWithConcurrency } from '@server/utils/concurrency';
import type { ReleaseCalendarItem } from './normalize';
import type { CalendarQuery } from './query';

const MAX_SOFTWARE_CALENDAR_REQUESTS = 1000;
const MAX_SOFTWARE_CALENDAR_LOOKUPS = 200;
const SOFTWARE_CALENDAR_LOOKUP_CONCURRENCY = 3;
const SOFTWARE_CATEGORIES = ['game', 'retro', 'modern'] as const;

type SoftwareCatalogLookup = Pick<QuestarrNGAPI, 'getCatalogGame'>;

interface SoftwareCalendarCategory {
  category: SoftwareRequestCategory;
  targets: Set<string>;
  available: boolean;
}

interface SoftwareCalendarLookup {
  provider: SoftwareRequestProvider;
  igdbId: number;
  title: string;
  categories: Map<SoftwareRequestCategory, SoftwareCalendarCategory>;
}

const catalogProviderFor = (
  category: SoftwareRequestCategory,
  emulationCatalogProvider: 'questarr' | 'romarr'
): SoftwareRequestProvider =>
  category === 'game' ? 'questarr' : emulationCatalogProvider;

const gameReleaseDate = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value))
    return;
  const datePart = value.slice(0, 10);
  const parsed = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === datePart
    ? parsed.toISOString()
    : undefined;
};

const requestTarget = (request: SoftwareRequest): string | undefined => {
  if (request.category === 'game') {
    const os = request.operatingSystem;
    const architecture = request.architecture;
    const osLabel =
      os === 'windows'
        ? 'Windows'
        : os === 'linux'
          ? 'Linux'
          : os === 'macos'
            ? 'macOS'
            : undefined;
    return [osLabel, architecture].filter(Boolean).join(' · ') || undefined;
  }
  return request.platformName?.trim().slice(0, 128) || undefined;
};

const catalogApi = (
  provider: SoftwareRequestProvider,
  settings: ReturnType<typeof getSettings>['softwareAcquisition']
): SoftwareCatalogLookup | undefined => {
  const connection = settings[provider];
  if (!connection.hostname || !connection.apiKey) return;
  return provider === 'questarr'
    ? new QuestarrNGAPI(connection)
    : new ROMarrNGAPI(connection);
};

export async function getSoftwareReleaseCalendar(
  query: CalendarQuery,
  userId: number
): Promise<{
  results: ReleaseCalendarItem[];
  partialSources: { source: string }[];
  truncated: boolean;
}> {
  const categories = SOFTWARE_CATEGORIES.filter(isMediaCategoryEnabled);
  if (!categories.length)
    return { results: [], partialSources: [], truncated: false };

  const requestQuery = getRepository(SoftwareRequest)
    .createQueryBuilder('request')
    .select([
      'request.id',
      'request.category',
      'request.status',
      'request.catalogId',
      'request.title',
      'request.platformName',
      'request.operatingSystem',
      'request.architecture',
      'request.updatedAt',
    ])
    .where('request.category IN (:...categories)', { categories })
    .andWhere('request.catalogId IS NOT NULL')
    .andWhere('request.status NOT IN (:...excludedStatuses)', {
      excludedStatuses: ['declined', 'cancelled'],
    })
    .orderBy('request.updatedAt', 'DESC')
    .take(MAX_SOFTWARE_CALENDAR_REQUESTS + 1);
  if (query.scope === 'mine')
    requestQuery.andWhere('request.requestedById = :userId', { userId });

  const requests = await requestQuery.getMany();
  let truncated = requests.length > MAX_SOFTWARE_CALENDAR_REQUESTS;
  const settings = getSettings().softwareAcquisition;
  const lookups = new Map<string, SoftwareCalendarLookup>();
  for (const request of requests.slice(0, MAX_SOFTWARE_CALENDAR_REQUESTS)) {
    if (
      !Number.isSafeInteger(request.catalogId) ||
      Number(request.catalogId) < 1
    )
      continue;
    const provider = catalogProviderFor(
      request.category,
      settings.emulationCatalogProvider
    );
    const igdbId = Number(request.catalogId);
    const key = `${provider}:${igdbId}`;
    let lookup = lookups.get(key);
    if (!lookup) {
      lookup = {
        provider,
        igdbId,
        title: request.title.slice(0, 512),
        categories: new Map(),
      };
      lookups.set(key, lookup);
    }
    let category = lookup.categories.get(request.category);
    if (!category) {
      category = {
        category: request.category,
        targets: new Set(),
        available: false,
      };
      lookup.categories.set(request.category, category);
    }
    const target = requestTarget(request);
    if (target) category.targets.add(target);
    category.available ||= request.status === 'available';
  }

  const candidates = [...lookups.values()];
  if (candidates.length > MAX_SOFTWARE_CALENDAR_LOOKUPS) truncated = true;
  const failedProviders = new Set<SoftwareRequestProvider>();
  const clients = new Map<
    SoftwareRequestProvider,
    SoftwareCatalogLookup | null
  >();
  const results = (
    await mapWithConcurrency(
      candidates.slice(0, MAX_SOFTWARE_CALENDAR_LOOKUPS),
      SOFTWARE_CALENDAR_LOOKUP_CONCURRENCY,
      async (lookup) => {
        let game: SoftwareCatalogGame;
        try {
          let api = clients.get(lookup.provider);
          if (api === undefined) {
            api = catalogApi(lookup.provider, settings) ?? null;
            clients.set(lookup.provider, api);
          }
          if (!api) {
            failedProviders.add(lookup.provider);
            return [];
          }
          game = await api.getCatalogGame(lookup.igdbId);
          if (
            !game ||
            typeof game !== 'object' ||
            game.igdbId !== lookup.igdbId
          ) {
            failedProviders.add(lookup.provider);
            return [];
          }
        } catch {
          failedProviders.add(lookup.provider);
          return [];
        }
        const startsAt = gameReleaseDate(game.releaseDate);
        if (!startsAt) return [];
        const releaseDate = new Date(startsAt);
        if (releaseDate < query.allDayStart || releaseDate >= query.allDayEnd)
          return [];
        return [...lookup.categories.values()].map((category) => ({
          id: `software:${category.category}:${lookup.igdbId}`,
          source: lookup.provider,
          mediaType: 'software' as const,
          title:
            typeof game.title === 'string' && game.title.trim()
              ? game.title.slice(0, 512)
              : lookup.title,
          startsAt,
          dateType: 'game' as const,
          allDay: true,
          softwareCategory: category.category,
          igdbId: lookup.igdbId,
          ...(category.targets.size
            ? {
                platformName: [...category.targets]
                  .sort()
                  .join(', ')
                  .slice(0, 512),
              }
            : {}),
          available: category.available,
          is4k: false,
        }));
      }
    )
  ).flat();

  return {
    results,
    partialSources: [...failedProviders].map((source) => ({ source })),
    truncated,
  };
}
