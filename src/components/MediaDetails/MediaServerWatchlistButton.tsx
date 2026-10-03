import Button from '@app/components/Common/Button';
import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import PageErrorMessage from '@app/components/Common/PageErrorMessage';
import Tooltip from '@app/components/Common/Tooltip';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { MediaServerType } from '@server/constants/server';
import type { MediaServerSavedItemStatus } from '@server/models/MediaServerSavedItem';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.MediaDetails.MediaServerWatchlistButton',
  {
    addWatchlist: 'Add to Watchlist',
    removeWatchlist: 'Remove from Watchlist',
    addFavorites: 'Add to Favorites',
    removeFavorites: 'Remove from Favorites',
    addHelp:
      'Add this entire series to your {server} {list}. Selected seasons and episodes are not added separately.',
    removeHelp:
      'Remove this entire series from your {server} {list}. This does not remove media or change your Seerr watchlist.',
    linkHelp: 'Link your own {server} account before saving this series.',
    missingHelp:
      'This series could not be matched in your accessible {server} catalog.',
    pendingHelp: 'The {server} saved state is loading or updating.',
    failedTitle: 'Media Server Saved State Unavailable',
    failed:
      'The saved state could not be loaded or updated. Please retry before changing it.',
    retry:
      'Reload the saved state from your own media-server account. This does not repeat an add or remove action.',
  }
);

type SavedItemProps = {
  tvId: number;
  is4k?: boolean;
  enabled?: boolean;
  onLoadingChange?: (loading: boolean) => void;
};
type SavedEnvelope = { context: string; status: MediaServerSavedItemStatus };
type LinkedIdentity = {
  id: number;
  plexId?: number | null;
  plexUsername?: string | null;
  jellyfinUsername?: string | null;
  updatedAt: Date;
};
const identityKey = (user: LinkedIdentity | undefined): string =>
  JSON.stringify(
    user
      ? [
          user.id,
          user.plexId ?? null,
          user.plexUsername ?? null,
          user.jellyfinUsername ?? null,
          String(user.updatedAt),
        ]
      : []
  );
const confirmedStatus = (
  value: unknown,
  serverType: MediaServerType
): MediaServerSavedItemStatus => {
  const status = value as MediaServerSavedItemStatus | undefined;
  if (
    !status ||
    status.serverType !== serverType ||
    status.kind !==
      (serverType === MediaServerType.PLEX ? 'watchlist' : 'favorites') ||
    typeof status.available !== 'boolean' ||
    (status.available && typeof status.saved !== 'boolean')
  )
    throw new Error('Native saved state could not be verified.');
  return status;
};
const freshReadConfig = {
  headers: { 'Cache-Control': 'no-cache' },
} as const;

const ActiveMediaServerWatchlistButton = ({
  tvId,
  is4k = false,
  onLoadingChange,
}: SavedItemProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const {
    user,
    loading: userLoading,
    error: userError,
    revalidate: revalidateUser,
  } = useUser();
  const configuredType = settings.currentSettings.mediaServerType;
  const endpoint = `/api/v1/tv/${tvId}/media-server-saved-item`;
  const readEndpoint = `${endpoint}?is4k=${is4k}`;
  const linkedIdentity = identityKey(user);
  const context = JSON.stringify([tvId, is4k, configuredType, linkedIdentity]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { data, error, isLoading, isValidating, mutate } =
    useSWR<SavedEnvelope>(
      user && !userError && configuredType !== MediaServerType.NOT_CONFIGURED
        ? [readEndpoint, context]
        : null,
      async ([url, requestContext]: [string, string]) => ({
        context: requestContext,
        status: confirmedStatus(
          (await axios.get<unknown>(url, freshReadConfig)).data,
          configuredType
        ),
      }),
      { shouldRetryOnError: false }
    );
  const [updating, setUpdating] = useState(false);
  const [failureContext, setFailureContext] = useState<string>();
  const inFlight = useRef(false);
  const status = data?.context === context ? data.status : undefined;
  const busy = userLoading || isLoading || isValidating || updating;
  useEffect(() => {
    setFailureContext(undefined);
  }, [context]);
  useEffect(() => {
    onLoadingChange?.(busy);
    return () => onLoadingChange?.(false);
  }, [busy, onLoadingChange]);
  if (configuredType === MediaServerType.NOT_CONFIGURED) return null;
  const serverType = configuredType;
  const server = getMediaServerName(serverType);
  if (!server) return null;
  const watchlist = serverType === MediaServerType.PLEX;
  const saved = status?.saved;
  const failed = !!error || !!userError || failureContext === context;
  const disabled =
    busy || failed || !user || !status?.available || typeof saved !== 'boolean';
  const help = intl.formatMessage(
    busy
      ? messages.pendingHelp
      : failed
        ? messages.failed
        : status?.reason === 'account-not-linked'
          ? messages.linkHelp
          : !status?.available
            ? messages.missingHelp
            : saved
              ? messages.removeHelp
              : messages.addHelp,
    { server, list: watchlist ? 'Watchlist' : 'Favorites' }
  );
  const toggle = async () => {
    if (disabled || inFlight.current) return;
    const actionContext = context;
    if (currentContext.current !== actionContext) return;
    inFlight.current = true;
    setUpdating(true);
    setFailureContext(undefined);
    const stillCurrent = () =>
      mounted.current && currentContext.current === actionContext;
    try {
      const freshUser = await revalidateUser();
      if (!stillCurrent()) return;
      if (!freshUser || identityKey(freshUser) !== linkedIdentity)
        throw new Error('Linked account changed.');
      const freshStatus = confirmedStatus(
        (await axios.get<unknown>(readEndpoint, freshReadConfig)).data,
        configuredType
      );
      if (!stillCurrent()) return;
      if (!freshStatus.available || typeof freshStatus.saved !== 'boolean')
        throw new Error('Native saving is unavailable.');
      const desired = !saved;
      const confirmed =
        freshStatus.saved === desired
          ? freshStatus
          : confirmedStatus(
              (await axios.post<unknown>(endpoint, { saved: desired, is4k }))
                .data,
              configuredType
            );
      if (!stillCurrent()) return;
      if (!confirmed.available || confirmed.saved !== desired)
        throw new Error('Native saved-state change was not confirmed.');
      await mutate(
        { context: actionContext, status: confirmed },
        { revalidate: false }
      );
    } catch {
      if (stillCurrent()) setFailureContext(actionContext);
    } finally {
      inFlight.current = false;
      if (mounted.current) setUpdating(false);
    }
  };
  return (
    <>
      <Tooltip content={help}>
        <span className="app-action-row">
          <Button
            buttonType="playback"
            disabled={disabled}
            disabledReason={help}
            title={help}
            aria-busy={busy}
            aria-pressed={typeof saved === 'boolean' ? saved : undefined}
            onClick={() => void toggle()}
          >
            <MediaServerIcon
              mediaServerType={serverType}
              className="playback-provider-icon"
            />
            <span>
              {intl.formatMessage(
                watchlist
                  ? saved
                    ? messages.removeWatchlist
                    : messages.addWatchlist
                  : saved
                    ? messages.removeFavorites
                    : messages.addFavorites
              )}
            </span>
          </Button>
        </span>
      </Tooltip>
      {failed && (
        <PageErrorMessage
          title={intl.formatMessage(messages.failedTitle)}
          description={intl.formatMessage(messages.failed)}
          retry={{
            tooltip: intl.formatMessage(messages.retry),
            busy,
            onClick: async () => {
              if (busy || inFlight.current) return;
              const retryContext = context;
              inFlight.current = true;
              setUpdating(true);
              setFailureContext(undefined);
              try {
                await revalidateUser();
                if (mounted.current && currentContext.current === retryContext)
                  await mutate();
              } catch {
                if (mounted.current && currentContext.current === retryContext)
                  setFailureContext(retryContext);
              } finally {
                inFlight.current = false;
                if (mounted.current) setUpdating(false);
              }
            },
          }}
        />
      )}
    </>
  );
};

const MediaServerWatchlistButton = (props: SavedItemProps) =>
  props.enabled === false ||
  !Number.isSafeInteger(props.tvId) ||
  props.tvId < 1 ||
  props.tvId > 1_000_000_000 ||
  (props.is4k !== undefined && typeof props.is4k !== 'boolean') ? null : (
    <ActiveMediaServerWatchlistButton {...props} />
  );

export default MediaServerWatchlistButton;
