import type { AudiobookshelfSettings } from '@server/lib/settings';
import axios from 'axios';

export interface AudiobookshelfLibrary {
  id: string;
  name: string;
  mediaType: 'book' | 'podcast' | string;
  numBooks?: number;
}

export interface AudiobookshelfLibraryItem {
  id: string;
  mediaType?: 'book' | 'podcast' | string;
  media?: {
    metadata?: {
      title?: string | null;
      authorName?: string | null;
      isbn?: string | null;
      asin?: string | null;
      publishedYear?: string | null;
    };
  };
  addedAt?: number;
}

export interface AudiobookshelfLibraryItemsResponse {
  results: AudiobookshelfLibraryItem[];
  total: number;
  limit: number;
  page: number;
}

export default class AudiobookshelfAPI {
  private readonly root: string;

  constructor(private readonly settings: AudiobookshelfSettings) {
    const protocol = settings.useSsl ? 'https' : 'http';
    const baseUrl = (settings.baseUrl ?? '').replace(/^\/+|\/+$/g, '');
    this.root = `${protocol}://${settings.hostname}:${settings.port}${baseUrl ? `/${baseUrl}` : ''}/api`;
  }

  private async get<T>(path: string, params?: Record<string, number>) {
    const response = await axios.get<T>(`${this.root}${path}`, {
      headers: { Authorization: `Bearer ${this.settings.apiKey}` },
      params,
      timeout: 15_000,
      maxContentLength: 32 * 1024 * 1024,
      maxBodyLength: 32 * 1024 * 1024,
    });

    return response.data;
  }

  public async getLibraries(): Promise<AudiobookshelfLibrary[]> {
    const response = await this.get<{ libraries: AudiobookshelfLibrary[] }>(
      '/libraries'
    );
    if (!response || !Array.isArray(response.libraries)) {
      throw new Error('Audiobookshelf returned an invalid library list.');
    }
    return response.libraries;
  }

  public async getLibraryItems(
    libraryId: string,
    page: number,
    limit: number
  ): Promise<AudiobookshelfLibraryItemsResponse> {
    if (
      !Number.isSafeInteger(page) ||
      page < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    ) {
      throw new Error('Audiobookshelf page request is invalid.');
    }

    const response = await this.get<AudiobookshelfLibraryItemsResponse>(
      `/libraries/${encodeURIComponent(libraryId)}/items`,
      { page, limit }
    );

    if (
      !response ||
      !Array.isArray(response.results) ||
      !Number.isSafeInteger(response.total) ||
      response.total < 0 ||
      response.page !== page ||
      response.limit !== limit ||
      response.results.length > limit
    ) {
      throw new Error('Audiobookshelf returned an invalid library page.');
    }

    return response;
  }

  public static buildItemUrl(
    settings: AudiobookshelfSettings,
    itemId: string
  ): string {
    const protocol = settings.useSsl ? 'https' : 'http';
    const baseUrl = (settings.baseUrl ?? '').replace(/^\/+|\/+$/g, '');
    const serviceUrl = new URL(
      settings.externalUrl ||
        `${protocol}://${settings.hostname}:${settings.port}`
    );
    serviceUrl.username = '';
    serviceUrl.password = '';
    serviceUrl.search = '';
    serviceUrl.hash = '';

    const externalPath = serviceUrl.pathname.replace(/\/+$/, '');
    const normalizedBaseUrl = baseUrl.toLowerCase();
    const externalPathAlreadyIncludesBaseUrl =
      normalizedBaseUrl &&
      (externalPath.toLowerCase() === `/${normalizedBaseUrl}` ||
        externalPath.toLowerCase().endsWith(`/${normalizedBaseUrl}`));
    const path = [
      externalPath,
      baseUrl && !externalPathAlreadyIncludesBaseUrl ? baseUrl : '',
      'item',
      encodeURIComponent(itemId),
    ]
      .filter(Boolean)
      .join('/');

    serviceUrl.pathname = path.startsWith('/') ? path : `/${path}`;
    return serviceUrl.toString();
  }
}
