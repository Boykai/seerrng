import ExternalAPI from '@server/api/externalapi';
import cacheManager from '@server/lib/cache';
import type { SoftwareProviderSettings } from '@server/lib/settings';
import { buildServiceUrl } from '@server/utils/serviceUrl';
import { Readable } from 'node:stream';
import type { SoftwareAssetStream } from './questarrng';
import type { SoftwareAssetsResponse, SoftwareProviderRequest } from './types';

export interface RomarrHandshake {
  service: string;
  version: string;
  apiVersion: number;
}

export interface RomarrPlatform {
  slug: string;
  name: string;
  aliases?: string[];
  media: string;
  extensions: string[];
  max_size_mb: number;
}

export interface RomarrLibraryLookup {
  ready: boolean;
  partial: boolean;
  matches: { title: string; platform: string }[];
}

export class ROMarrNGAPI extends ExternalAPI {
  static buildUrl(
    settings: Pick<
      SoftwareProviderSettings,
      'useSsl' | 'hostname' | 'port' | 'baseUrl'
    >,
    path = ''
  ): string {
    return buildServiceUrl({
      useSsl: settings.useSsl,
      hostname: settings.hostname,
      port: settings.port,
      urlBase: settings.baseUrl,
      path,
    });
  }

  constructor(settings: SoftwareProviderSettings) {
    super(
      ROMarrNGAPI.buildUrl(settings),
      {},
      {
        allowPrivateAddresses: true,
        nodeCache: cacheManager.getCache('romarr').data,
        headers: { 'X-Api-Key': settings.apiKey },
      }
    );
  }

  public getHandshake(): Promise<RomarrHandshake> {
    return this.get('/api/v1/integration/ping', {}, 0);
  }

  public getPlatforms(forceFresh = false): Promise<RomarrPlatform[]> {
    return this.get('/api/platforms', {}, forceFresh ? 0 : 300);
  }

  public lookupLibrary(
    titles: { title: string; platform: string }[]
  ): Promise<RomarrLibraryLookup> {
    return this.post('/api/v1/integration/library/lookup', { titles });
  }

  public createRequest(
    externalRequestId: string,
    game: string,
    platform: string
  ): Promise<SoftwareProviderRequest> {
    return this.post('/api/v1/integration/requests', {
      externalRequestId,
      game,
      platform,
    });
  }

  public getRequest(
    externalRequestId: string
  ): Promise<SoftwareProviderRequest> {
    return this.get(
      `/api/v1/integration/requests/${encodeURIComponent(externalRequestId)}`,
      {},
      0
    );
  }

  public retryRequest(
    externalRequestId: string,
    confirmNoExistingDownload = false
  ): Promise<SoftwareProviderRequest> {
    return this.post(
      `/api/v1/integration/requests/${encodeURIComponent(externalRequestId)}/retry`,
      { confirmNoExistingDownload }
    );
  }

  public cancelRequest(
    externalRequestId: string,
    confirmNoExistingDownload = false
  ): Promise<SoftwareProviderRequest> {
    return this.post(
      `/api/v1/integration/requests/${encodeURIComponent(externalRequestId)}/cancel`,
      { confirmNoExistingDownload }
    );
  }

  public getAssets(externalRequestId: string): Promise<SoftwareAssetsResponse> {
    return this.get(
      `/api/v1/integration/requests/${encodeURIComponent(externalRequestId)}/assets`,
      {},
      0
    );
  }

  public async streamAsset(
    externalRequestId: string,
    assetId: string,
    range?: string
  ): Promise<SoftwareAssetStream> {
    const response = await this.request<Readable>(
      'GET',
      `/api/v1/integration/requests/${encodeURIComponent(externalRequestId)}/assets/${encodeURIComponent(assetId)}`,
      undefined,
      {
        responseType: 'stream',
        headers: range ? { Range: range } : {},
        validateStatus: (status) =>
          status === 200 || status === 206 || status === 416,
      }
    );
    if (response.status === 416) {
      response.data.destroy();
      const contentRange = response.headers['content-range'];
      return {
        stream: Readable.from([]),
        contentLength: 0,
        rangeSupported: true,
        statusCode: 416,
        contentRange:
          typeof contentRange === 'string' &&
          /^bytes \*\/\d+$/.test(contentRange)
            ? contentRange
            : undefined,
      };
    }
    return {
      stream: response.data,
      filename: response.headers['content-disposition'],
      contentLength: Number(response.headers['content-length']) || undefined,
      contentType:
        typeof response.headers['content-type'] === 'string'
          ? response.headers['content-type']
          : undefined,
      rangeSupported: response.headers['accept-ranges'] === 'bytes',
      statusCode: response.status,
      contentRange: response.headers['content-range'],
    };
  }
}

export default ROMarrNGAPI;
