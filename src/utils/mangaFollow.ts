import {
  MANGA_FOLLOW_ENABLE_STATUSES,
  MangaFollowStopReason,
} from '@server/constants/mangaFollow';
import type { MediaRequestStatus } from '@server/constants/media';
import type { MangaRequestScopeSummary } from '@server/lib/mangaRequests';
import { hasPermission, Permission } from '@server/lib/permissions';

/** The body of `PUT /api/v1/request/{requestId}/follow`. */
export interface MangaFollowRequestBody {
  enabled: boolean;
}

export const getMangaFollowUrl = (requestId: number): string =>
  `/api/v1/request/${requestId}/follow`;

export const buildMangaFollowBody = (
  enabled: boolean
): MangaFollowRequestBody => ({ enabled });

/**
 * The `mangaFollow` field of `POST /api/v1/request`. It is sent only when the
 * requester turns following on, so a request made with following off carries
 * exactly the body it had before the field existed.
 */
export const buildMangaFollowCreateField = (
  follow: boolean
): { mangaFollow?: true } => (follow ? { mangaFollow: true } : {});

/** The part of a manga request's follow summary that the UI shows. */
export interface MangaFollowState {
  enabled: boolean;
  stopReason: MangaFollowStopReason | null;
}

const STOP_REASONS = new Set<string>(Object.values(MangaFollowStopReason));

/**
 * Reads the follow summary that the request APIs attach to a manga request's
 * `mangaScope`. Returns undefined for other requests and for a summary
 * without follow state; an unknown stop reason reads as none.
 */
export const getMangaFollowState = (
  request: object
): MangaFollowState | undefined => {
  const follow = (request as { mangaScope?: Partial<MangaRequestScopeSummary> })
    .mangaScope?.follow;
  if (typeof follow?.enabled !== 'boolean') {
    return undefined;
  }
  return {
    enabled: follow.enabled,
    stopReason:
      typeof follow.stopReason === 'string' &&
      STOP_REASONS.has(follow.stopReason)
        ? (follow.stopReason as MangaFollowStopReason)
        : null,
  };
};

export interface MangaFollowControlInput {
  requestType: string;
  requestStatus: MediaRequestStatus;
  /** Absent when the request reaches the viewer without its requester. */
  requestedById?: number;
  follow?: MangaFollowState;
  userId?: number;
  permissions: number;
}

export interface MangaFollowControlState {
  /** The viewer may turn following on, or keep it on. */
  canTurnOn: boolean;
  /** Following is on and the viewer may turn it off. */
  canTurnOff: boolean;
}

/**
 * Mirrors `PUT /request/{requestId}/follow`: only the owner may turn
 * following on, while the request is pending, approved or completed and the
 * owner may request manga; the owner or a request manager may turn it off.
 * Returns null when the viewer has no follow control.
 */
export const getMangaFollowControlState = ({
  requestType,
  requestStatus,
  requestedById,
  follow,
  userId,
  permissions,
}: MangaFollowControlInput): MangaFollowControlState | null => {
  if (requestType !== 'manga' || !follow) {
    return null;
  }
  const isOwner = userId !== undefined && userId === requestedById;
  const canTurnOn =
    isOwner &&
    MANGA_FOLLOW_ENABLE_STATUSES.includes(requestStatus) &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_MANGA], permissions, {
      type: 'or',
    });
  const canTurnOff =
    follow.enabled &&
    (isOwner || hasPermission(Permission.MANAGE_REQUESTS, permissions));
  return canTurnOn || canTurnOff ? { canTurnOn, canTurnOff } : null;
};
