import type { PaginatedResponse } from '@server/interfaces/api/common';

/**
 * `available`: Suwayomi reports the chapter downloaded. `requested`: a
 * request the viewer may see asks for it. Anything else is `notRequested`.
 */
export type MangaChapterStatus = 'available' | 'requested' | 'notRequested';

export interface MangaChapterResult {
  /** Null when the source gives the chapter no number. */
  number: number | null;
  /** Empty when the name is unknown. */
  name: string;
  /** ISO 8601, or null when unknown. */
  uploadedAt: string | null;
  status: MangaChapterStatus;
  /**
   * A verified copy the viewer may download through
   * `GET /request/status/{requestId}/downloads/{assetId}`.
   */
  download?: { requestId: number; assetId: string };
}

export interface MangaChapterPageResponse extends PaginatedResponse {
  /** True when the chapters come from a Suwayomi library. */
  inLibrary: boolean;
  results: MangaChapterResult[];
}
