import ExternalAPI from '@server/api/externalapi';
import type { BackIssueSettings } from '@server/lib/settings';
import { buildServiceUrl } from '@server/utils/serviceUrl';

export interface BackIssueCollectionItem {
  id: number;
  title: string;
  cv_id: number;
  total: number;
  owned: number;
  missing: number;
  active: number;
  type?: string;
}

export interface BackIssueCollectionDetail {
  id: number;
  title: string;
  cv_id?: number;
  files: { path: string; name?: string; size?: number }[];
}

export interface BackIssueAddResult {
  seriesId: number;
  outcome?: string;
}

export interface BackIssueAbout {
  version: string;
}

export class BackIssuePermissionError extends Error {
  public constructor(missingPermissions: string[]) {
    super(
      `BackIssue API key is missing required permissions: ${missingPermissions.join(', ')}.`
    );
  }
}

export interface BackIssueQueueItem {
  id: number;
  seriesId: number;
  title: string;
  status: string;
  progress?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const boundedInteger = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

const boundedString = (value: unknown, max = 1_000): string | undefined =>
  typeof value === 'string' && value.length > 0
    ? value.slice(0, max)
    : undefined;

const sanitizeCollectionItem = (
  value: unknown
): BackIssueCollectionItem | undefined => {
  if (!isRecord(value)) return undefined;
  const id = boundedInteger(value.id);
  const cvId = boundedInteger(value.cv_id);
  const title = boundedString(value.title);
  if (id === undefined || cvId === undefined || cvId === 0 || !title) {
    return undefined;
  }
  return {
    id,
    title,
    cv_id: cvId,
    total: boundedInteger(value.total) ?? 0,
    owned: boundedInteger(value.owned) ?? 0,
    missing: boundedInteger(value.missing) ?? 0,
    active: boundedInteger(value.active) ?? 0,
    type: boundedString(value.type, 64),
  };
};

const sanitizeCollectionDetail = (
  value: unknown
): BackIssueCollectionDetail | undefined => {
  if (!isRecord(value)) return undefined;
  const id = boundedInteger(value.id);
  const title = boundedString(value.title);
  if (id === undefined || !title) return undefined;
  const cvId = boundedInteger(value.cv_id);
  const files = (Array.isArray(value.files) ? value.files : []).flatMap(
    (candidate) => {
      if (!isRecord(candidate)) return [];
      const filePath = boundedString(candidate.path, 4_096);
      if (!filePath || filePath.includes('\0')) return [];
      return [
        {
          path: filePath,
          name: boundedString(candidate.name, 255),
          size: boundedInteger(candidate.size),
        },
      ];
    }
  );
  return { id, title, cv_id: cvId, files };
};

class BackIssueAPI extends ExternalAPI {
  static buildUrl(
    settings: Pick<
      BackIssueSettings,
      'useSsl' | 'hostname' | 'port' | 'baseUrl'
    >,
    path?: string
  ): string {
    return buildServiceUrl({
      useSsl: settings.useSsl,
      hostname: settings.hostname,
      port: settings.port,
      urlBase: settings.baseUrl,
      path,
    });
  }

  constructor({ url, apiKey }: { url: string; apiKey: string }) {
    super(
      url,
      {},
      {
        allowPrivateAddresses: true,
        headers: { 'X-Api-Key': apiKey },
        timeout: 30_000,
      }
    );
  }

  public async getAbout(): Promise<BackIssueAbout> {
    const identity = await this.get<unknown>('/api/auth/me', {}, 0);
    if (!isRecord(identity) || !isRecord(identity.user)) {
      throw new Error('BackIssue did not return an authenticated user.');
    }
    const permissions = Array.isArray(identity.user.permissions)
      ? identity.user.permissions.filter(
          (permission): permission is string => typeof permission === 'string'
        )
      : [];
    const missingPermissions = [
      'library.view',
      'library.manage',
      'downloads.grab',
    ].filter(
      (permission) =>
        !permissions.includes('*') && !permissions.includes(permission)
    );
    if (missingPermissions.length > 0) {
      throw new BackIssuePermissionError(missingPermissions);
    }
    const status = await this.get<unknown>('/api/status', {}, 0);
    if (!isRecord(status)) {
      throw new Error('BackIssue returned an invalid status response.');
    }
    return { version: boundedString(status.version, 64) ?? 'unknown' };
  }

  public async getCollection(): Promise<BackIssueCollectionItem[]> {
    const pageSize = 500;
    const rows: BackIssueCollectionItem[] = [];
    let offset = 0;
    let total: number | undefined;

    do {
      const response = await this.get<unknown>(
        '/api/collection',
        { params: { limit: pageSize, offset, counts: 0 } },
        0
      );
      const pageTotal = isRecord(response)
        ? boundedInteger(response.total)
        : undefined;
      if (
        !isRecord(response) ||
        !Array.isArray(response.rows) ||
        pageTotal === undefined ||
        response.rows.length > pageSize
      ) {
        throw new Error('BackIssue returned an invalid collection page.');
      }
      if (
        offset > pageTotal ||
        (response.rows.length === 0 && offset < pageTotal)
      ) {
        throw new Error('BackIssue returned an incomplete collection page.');
      }
      const pageRows = response.rows
        .map(sanitizeCollectionItem)
        .filter((item): item is BackIssueCollectionItem => !!item);
      rows.push(...pageRows);
      total = pageTotal;
      offset += response.rows.length;
    } while (offset < total);

    return rows;
  }

  public async addVolume(comicVineId: number): Promise<BackIssueAddResult> {
    const response = await this.post<unknown>(
      '/api/collection/add-cv',
      { comicvineId: comicVineId },
      undefined,
      0
    );
    if (!isRecord(response)) {
      throw new Error('BackIssue returned an invalid add response.');
    }
    const seriesId = boundedInteger(response.seriesId);
    if (seriesId === undefined) {
      throw new Error('BackIssue did not return the added series ID.');
    }
    return {
      seriesId,
      outcome: boundedString(response.outcome, 64),
    };
  }

  public async getSeries(
    id: number
  ): Promise<BackIssueCollectionDetail | undefined> {
    const response = await this.get<unknown>(`/api/collection/${id}`, {}, 0);
    return sanitizeCollectionDetail(response);
  }

  public async removeSeries(id: number): Promise<void> {
    await this.post(
      '/api/collection/' + id + '/delete',
      { deleteFiles: false },
      undefined,
      0
    );
  }

  public async getQueue(): Promise<BackIssueQueueItem[]> {
    const response = await this.get<unknown>('/api/queue', {}, 0);
    if (!isRecord(response) || !Array.isArray(response.items)) {
      throw new Error('BackIssue returned an invalid queue response.');
    }
    return response.items.flatMap((candidate) => {
      if (!isRecord(candidate)) return [];
      const id = boundedInteger(candidate.id);
      const seriesId = boundedInteger(candidate.series_id);
      if (id === undefined || seriesId === undefined) return [];
      const live = isRecord(candidate.live) ? candidate.live : undefined;
      const rawProgress = live?.progress;
      return [
        {
          id,
          seriesId,
          title: boundedString(candidate.series_title ?? candidate.title) ?? '',
          status: boundedString(candidate.status, 64) ?? 'queued',
          progress:
            typeof rawProgress === 'number' &&
            Number.isFinite(rawProgress) &&
            rawProgress >= 0 &&
            rawProgress <= 100
              ? rawProgress
              : undefined,
        },
      ];
    });
  }

  public async cancelQueueItem(id: number): Promise<void> {
    await this.post(`/api/queue/cancel/${id}`, {}, undefined, 0);
  }
}

export default BackIssueAPI;
