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
import type { ReactNode } from 'react';
import { useEffect, useId, useState } from 'react';
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
  requestedBy?: { id: number };
}

type FollowValue = 'off' | 'on';

interface MangaFollowControlProps {
  request: MangaFollowRequest;
  onUpdated: () => Promise<unknown>;
}

/**
 * The viewer's follow choice for a saved request. `update` saves a change
 * with `PUT /request/{requestId}/follow` and then refreshes through
 * `onUpdated`, like the watch-ahead choice. `control` is null when the viewer
 * has no follow control for the request.
 */
const useMangaFollowChoice = ({
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
    requestedById: request.requestedBy?.id,
    follow: follow && { ...follow, enabled },
    userId: user?.id,
    permissions: user?.permissions ?? 0,
  });

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

  return { control, enabled, isUpdating, update };
};

interface MangaFollowListboxProps {
  id: string;
  enabled: boolean;
  canTurnOn: boolean;
  disabled: boolean;
  onChange: (value: FollowValue) => void;
}

/** The shared request listbox with Off, and On where the viewer may choose it. */
const MangaFollowListbox = ({
  id,
  enabled,
  canTurnOn,
  disabled,
  onChange,
}: MangaFollowListboxProps) => {
  const intl = useIntl();
  const options: { value: FollowValue; label: string }[] = [
    { value: 'off', label: intl.formatMessage(messages.off) },
    ...(canTurnOn
      ? [{ value: 'on' as const, label: intl.formatMessage(messages.on) }]
      : []),
  ];

  return (
    <RequestListboxControl<FollowValue>
      id={id}
      label={intl.formatMessage(messages.label)}
      value={enabled ? 'on' : 'off'}
      options={options}
      disabled={disabled}
      onChange={onChange}
      loadingLabel={intl.formatMessage(enabled ? messages.on : messages.off)}
    />
  );
};

/** A standard inset card holding the follow choice and its explanation. */
const MangaFollowCard = ({ children }: { children: ReactNode }) => {
  const intl = useIntl();
  return (
    <div className="app-card-inset refreshed-inset-surface card-spacing-before rounded-lg border border-gray-700 p-3">
      {children}
      <p className="refreshed-detail-text-muted mt-2 text-xs">
        {intl.formatMessage(messages.description)}
      </p>
    </div>
  );
};

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
  const { control, enabled, isUpdating, update } = useMangaFollowChoice({
    request,
    onUpdated,
  });
  if (!control) {
    return null;
  }

  return (
    <Tooltip content={intl.formatMessage(messages.description)}>
      <span className="inline-flex">
        <MangaFollowListbox
          id={`manga-follow-${request.id}`}
          enabled={enabled}
          canTurnOn={control.canTurnOn}
          disabled={isUpdating}
          onChange={(value) => void update(value)}
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

/**
 * The same choice in a manga request window: the control in an inset card
 * for a viewer who has it, then the status line of a paused or stopped
 * request. A change saves at once, apart from the window's own Save.
 */
export const MangaFollowRequestSettings = ({
  request,
  onUpdated,
}: MangaFollowControlProps) => {
  const { control, enabled, isUpdating, update } = useMangaFollowChoice({
    request,
    onUpdated,
  });

  return (
    <>
      {control && (
        <MangaFollowCard>
          <MangaFollowListbox
            id={`manga-follow-request-${request.id}`}
            enabled={enabled}
            canTurnOn={control.canTurnOn}
            disabled={isUpdating}
            onChange={(value) => void update(value)}
          />
        </MangaFollowCard>
      )}
      <MangaFollowStatusLine request={request} />
    </>
  );
};

interface MangaFollowFieldProps {
  enabled: boolean;
  disabled: boolean;
  onChange: (enabled: boolean) => void;
}

/**
 * The choice in a new manga request: Off by default, and sent with the
 * request only when the requester turns it on.
 */
export const MangaFollowField = ({
  enabled,
  disabled,
  onChange,
}: MangaFollowFieldProps) => {
  const id = useId();
  return (
    <MangaFollowCard>
      <MangaFollowListbox
        id={`manga-follow-${id}`}
        enabled={enabled}
        canTurnOn
        disabled={disabled}
        onChange={(value) => onChange(value === 'on')}
      />
    </MangaFollowCard>
  );
};
