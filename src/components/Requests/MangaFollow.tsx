import Tooltip from '@app/components/Common/Tooltip';
import { RequestListboxControl } from '@app/components/RequestModal/AdvancedRequester';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  buildMangaFollowBody,
  getMangaFollowControlState,
  getMangaFollowState,
  getMangaFollowUrl,
} from '@app/utils/mangaFollow';
import {
  MANGA_FOLLOW_MANIFEST_LIMIT,
  MangaFollowStopReason,
} from '@server/constants/mangaFollow';
import type { MediaRequestStatus } from '@server/constants/media';
import axios from 'axios';
import { useEffect, useState } from 'react';
import type { MessageDescriptor } from 'react-intl';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Requests.MangaFollow', {
  label: 'Follow New Chapters',
  description:
    'This option is Off by default for every manga request. If you turn it on, SeerrNG checks for new chapters that fit this request and queues them for download, so a completed request goes back to downloading while they arrive. Only the requester can turn it on; the requester or a user who can manage requests can turn it off. New chapters use this request’s approval and do not count against your request quota. Turning it off stops future additions but does not cancel chapters already added.',
  off: 'Off',
  on: 'On',
  updated: 'Following new chapters updated.',
  failed: 'Unable to update following new chapters.',
  ownerNotPermitted:
    'Following new chapters stopped because the requester can no longer request manga.',
  requestDeclined:
    'Following new chapters stopped because this request was declined.',
  requestFailed: 'Following new chapters stopped because this request failed.',
  rangeComplete:
    'Following new chapters stopped because this request already includes the last chapter of its range.',
  manifestLimit:
    'Following new chapters stopped because this request reached the limit of {limit} chapters.',
  bindingInactive:
    'Following new chapters is paused because this title has no active match on the connected manga service. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
  instanceMissing:
    'Following new chapters is paused because the manga service this request was made for is no longer configured, or its settings are incomplete. SeerrNG checks again every day; an administrator can check it under Settings → Services.',
  bindingChanged:
    'Following new chapters is paused because this title is now matched to a different manga on the connected manga service. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
  mangaNotFound:
    'Following new chapters is paused because the connected manga service no longer has the manga this request was sent to. SeerrNG checks again every day; an administrator can review the match under Settings → Manga Library.',
});

const stopReasonMessages: Record<MangaFollowStopReason, MessageDescriptor> = {
  [MangaFollowStopReason.OWNER_NOT_PERMITTED]: messages.ownerNotPermitted,
  [MangaFollowStopReason.REQUEST_DECLINED]: messages.requestDeclined,
  [MangaFollowStopReason.REQUEST_FAILED]: messages.requestFailed,
  [MangaFollowStopReason.RANGE_COMPLETE]: messages.rangeComplete,
  [MangaFollowStopReason.MANIFEST_LIMIT]: messages.manifestLimit,
  [MangaFollowStopReason.BINDING_INACTIVE]: messages.bindingInactive,
  [MangaFollowStopReason.INSTANCE_MISSING]: messages.instanceMissing,
  [MangaFollowStopReason.BINDING_CHANGED]: messages.bindingChanged,
  [MangaFollowStopReason.MANGA_NOT_FOUND]: messages.mangaNotFound,
};

/** The request fields the follow control and status line read. */
export interface MangaFollowRequest {
  id: number;
  type: string;
  status: MediaRequestStatus;
  requestedBy: { id: number };
}

type FollowValue = 'off' | 'on';

interface MangaFollowControlProps {
  request: MangaFollowRequest;
  onUpdated: () => Promise<unknown>;
}

/**
 * The "Follow New Chapters" choice on a manga request card. The owner can
 * turn following on and off; a request manager sees it only while following
 * is on, and can only turn it off.
 */
export const MangaFollowControl = ({
  request,
  onUpdated,
}: MangaFollowControlProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user } = useUser();
  const follow = getMangaFollowState(request);
  const [enabled, setEnabled] = useState(follow?.enabled ?? false);
  const [isUpdating, setIsUpdating] = useState(false);
  useEffect(() => {
    setEnabled(follow?.enabled ?? false);
  }, [request.id, follow?.enabled]);

  const control = getMangaFollowControlState({
    requestType: request.type,
    requestStatus: request.status,
    requestedById: request.requestedBy.id,
    follow: follow && { ...follow, enabled },
    userId: user?.id,
    permissions: user?.permissions ?? 0,
  });
  if (!control) {
    return null;
  }

  const update = async (value: FollowValue) => {
    const nextEnabled = value === 'on';
    if (nextEnabled === enabled) {
      return;
    }
    setIsUpdating(true);
    try {
      await axios.put(
        getMangaFollowUrl(request.id),
        buildMangaFollowBody(nextEnabled)
      );
      setEnabled(nextEnabled);
      await onUpdated();
      addToast(intl.formatMessage(messages.updated), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };

  const options: { value: FollowValue; label: string }[] = [
    { value: 'off', label: intl.formatMessage(messages.off) },
    ...(control.canTurnOn
      ? [{ value: 'on' as const, label: intl.formatMessage(messages.on) }]
      : []),
  ];

  return (
    <Tooltip content={intl.formatMessage(messages.description)}>
      <span className="inline-flex">
        <RequestListboxControl<FollowValue>
          id={`manga-follow-${request.id}`}
          label={intl.formatMessage(messages.label)}
          value={enabled ? 'on' : 'off'}
          options={options}
          disabled={isUpdating}
          onChange={(value) => void update(value)}
          loadingLabel={intl.formatMessage(
            enabled ? messages.on : messages.off
          )}
        />
      </span>
    </Tooltip>
  );
};

/** One fixed sentence for a manga request whose following paused or stopped. */
export const MangaFollowStatusLine = ({
  request,
}: {
  request: MangaFollowRequest;
}) => {
  const intl = useIntl();
  const follow = getMangaFollowState(request);
  if (request.type !== 'manga' || !follow?.stopReason) {
    return null;
  }
  return (
    <p className="request-status-note refreshed-detail-text">
      {intl.formatMessage(stopReasonMessages[follow.stopReason], {
        limit: intl.formatNumber(MANGA_FOLLOW_MANIFEST_LIMIT),
      })}
    </p>
  );
};
