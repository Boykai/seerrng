import ExternalAPI from '@server/api/externalapi';
import type { ProwlarrSettings } from '@server/lib/settings';
import { buildServiceUrl } from '@server/utils/serviceUrl';

export interface ProwlarrIndexerCategory {
  id?: number;
  name?: string;
  subCategories?: ProwlarrIndexerCategory[];
}

export interface ProwlarrIndexerResource {
  id?: number;
  name?: string;
  enable?: boolean;
  supportsSearch?: boolean;
  protocol?: string;
  capabilities?: {
    categories?: ProwlarrIndexerCategory[];
  };
}

export interface ProwlarrSearchResource {
  title?: string;
  indexer?: string;
  indexerId?: number;
  size?: number;
  seeders?: number | null;
  leechers?: number | null;
  grabs?: number | null;
  protocol?: string;
  publishDate?: string;
  infoUrl?: string;
  categories?: ProwlarrIndexerCategory[];
}

export class ProwlarrAPI extends ExternalAPI {
  static buildUrl(
    settings: Pick<ProwlarrSettings, 'useSsl' | 'hostname' | 'port' | 'baseUrl'>
  ): string {
    return buildServiceUrl({
      useSsl: settings.useSsl,
      hostname: settings.hostname,
      port: settings.port,
      urlBase: settings.baseUrl,
      path: '/api/v1',
    });
  }

  constructor(settings: ProwlarrSettings) {
    super(
      ProwlarrAPI.buildUrl(settings),
      {},
      {
        allowPrivateAddresses: true,
        timeout: 45_000,
        maxContentLength: 8 * 1024 * 1024,
        headers: { 'X-Api-Key': settings.apiKey },
      }
    );
  }

  public getSystemStatus(): Promise<{ version?: string }> {
    return this.get('/system/status', undefined, 0);
  }

  public getIndexers(): Promise<ProwlarrIndexerResource[]> {
    return this.get('/indexer', undefined, 0);
  }

  public search(
    query: string,
    categories: number[],
    limit: number,
    offset: number
  ): Promise<ProwlarrSearchResource[]> {
    const params = new URLSearchParams({
      query,
      type: 'search',
      limit: String(limit),
      offset: String(offset),
    });
    for (const category of categories) {
      params.append('categories', String(category));
    }
    return this.get('/search', { params }, 0);
  }
}

export default ProwlarrAPI;
