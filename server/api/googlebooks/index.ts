import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';

const MAX_GOOGLE_BOOKS_TEXT_LENGTH = 20_000;
const MAX_GOOGLE_BOOKS_TITLE_LENGTH = 1_000;
const MAX_GOOGLE_BOOKS_ID_LENGTH = 128;
export const MAX_GOOGLE_BOOKS_PAGE_SIZE = 40;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const boundedString = (
  value: unknown,
  maxLength = MAX_GOOGLE_BOOKS_TEXT_LENGTH
): string | undefined =>
  typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : undefined;

const boundedInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const sanitizeGoogleBooksUrl = (
  value: unknown,
  options: { image?: boolean } = {}
): string | undefined => {
  const candidate = boundedString(value, 2048);
  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate);
    if (
      url.username ||
      url.password ||
      !['books.google.com', 'books.googleusercontent.com'].includes(
        url.hostname.toLowerCase()
      )
    ) {
      return undefined;
    }

    if (options.image && !url.pathname.startsWith('/books')) {
      return undefined;
    }

    url.protocol = 'https:';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
};

export interface GoogleBooksMagazineResult {
  id: string;
  title: string;
  publisher?: string;
  publishedDate?: string;
  description?: string;
  imageUrl?: string;
  infoUrl?: string;
}

export interface GoogleBooksMagazineSearchResponse {
  totalItems: number;
  results: GoogleBooksMagazineResult[];
}

const sanitizeMagazineVolume = (
  value: unknown
): GoogleBooksMagazineResult | undefined => {
  if (!isRecord(value) || !isRecord(value.volumeInfo)) {
    return undefined;
  }

  const volumeId = boundedString(value.id, MAX_GOOGLE_BOOKS_ID_LENGTH);
  const volumeInfo = value.volumeInfo;
  const title = boundedString(volumeInfo.title, MAX_GOOGLE_BOOKS_TITLE_LENGTH);
  if (
    !volumeId ||
    !/^[A-Za-z0-9_-]+$/.test(volumeId) ||
    !title ||
    volumeInfo.printType !== 'MAGAZINE'
  ) {
    return undefined;
  }

  const imageLinks = isRecord(volumeInfo.imageLinks)
    ? volumeInfo.imageLinks
    : undefined;

  return {
    id: volumeId,
    title,
    publisher: boundedString(volumeInfo.publisher, 512),
    publishedDate: boundedString(volumeInfo.publishedDate, 32),
    description: boundedString(volumeInfo.description),
    imageUrl:
      sanitizeGoogleBooksUrl(imageLinks?.thumbnail, { image: true }) ??
      sanitizeGoogleBooksUrl(imageLinks?.smallThumbnail, { image: true }),
    infoUrl: sanitizeGoogleBooksUrl(volumeInfo.infoLink),
  };
};

class GoogleBooksAPI extends ExternalAPI {
  constructor(apiKey: string) {
    super(
      'https://www.googleapis.com/books/v1',
      { key: apiKey },
      {
        nodeCache: cacheManager.getCache('googlebooks').data,
        rateLimit: {
          maxRequests: 30,
          maxRPS: 1,
        },
      }
    );
  }

  public async searchMagazines({
    query,
    page = 1,
    limit = 20,
  }: {
    query: string;
    page?: number;
    limit?: number;
  }): Promise<GoogleBooksMagazineSearchResponse> {
    const boundedLimit = Math.min(
      Math.max(1, limit),
      MAX_GOOGLE_BOOKS_PAGE_SIZE
    );
    const startIndex = Math.max(0, (page - 1) * boundedLimit);
    const normalizedQuery = query.trim().slice(0, 256);
    if (!normalizedQuery) {
      return { totalItems: 0, results: [] };
    }

    const response = await this.get<unknown>(
      '/volumes',
      {
        params: {
          q: `intitle:${normalizedQuery}`,
          printType: 'magazines',
          orderBy: 'relevance',
          startIndex,
          maxResults: boundedLimit,
        },
      },
      300
    );

    if (!isRecord(response)) {
      throw new Error('Google Books returned an invalid search response.');
    }

    return {
      totalItems: boundedInteger(response.totalItems) ?? 0,
      results: Array.isArray(response.items)
        ? response.items
            .map(sanitizeMagazineVolume)
            .filter((result): result is GoogleBooksMagazineResult => !!result)
        : [],
    };
  }
}

export default GoogleBooksAPI;
