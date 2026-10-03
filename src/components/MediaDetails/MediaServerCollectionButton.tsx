import Dropdown from '@app/components/Common/Dropdown';
import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import PageErrorMessage from '@app/components/Common/PageErrorMessage';
import Tooltip from '@app/components/Common/Tooltip';
import useSettings from '@app/hooks/useSettings';
import { useUser, type User } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { MediaServerType } from '@server/constants/server';
import type { MediaServerCollectionsStatus } from '@server/models/MediaServerCollections';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.MediaDetails.MediaServerCollectionButton',
  {
    addCollection: 'Add to Collection',
    addNamed: 'Add to {name}',
    removeNamed: 'Remove from {name}',
    help: 'Choose an existing shared {server} collection to add or remove this entire series. Selected episodes are not added separately.',
    link: 'Link your own {server} account before changing its collections.',
    permission:
      'Your linked {server} account does not have permission to manage these shared collections.',
    missing:
      'This series is not available in your accessible {server} library for the selected quality.',
    limit:
      'The {server} collection list exceeds the supported limit. No partial list is offered.',
    empty:
      'Create a collection in {server} first. SeerrNG only adds titles to existing collections.',
    busy: 'The {server} collection state is loading or updating.',
    unavailable: 'Collections are unavailable for the configured media server.',
    errorTitle: 'Media Server Collections Unavailable',
    error:
      'The collections could not be loaded or the change could not be confirmed. Reload their current state before changing membership.',
    retry:
      'Reload collection membership from your linked media-server account. This does not repeat an add or remove action.',
  }
);

export interface MediaServerCollectionButtonProps {
  tvId: number;
  is4k?: boolean;
  enabled?: boolean;
  onLoadingChange?: (loading: boolean) => void;
}
type Envelope = { context: string; status: MediaServerCollectionsStatus };
type ReadKey = [string, string, MediaServerType];
const freshReadConfig = { headers: { 'Cache-Control': 'no-cache' } } as const;
const identityKey = (user: User | undefined): string =>
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
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const confirmedStatus = (
  value: unknown,
  serverType: MediaServerType
): MediaServerCollectionsStatus => {
  const reasons = [
    'account-not-linked',
    'not-authorized',
    'series-not-found',
    'unsupported-server',
    'collection-limit',
  ];
  if (
    !record(value) ||
    value.serverType !== serverType ||
    typeof value.available !== 'boolean' ||
    !Array.isArray(value.collections) ||
    value.collections.length > 500 ||
    (value.reason !== undefined && !reasons.includes(String(value.reason))) ||
    (!value.available && value.collections.length !== 0)
  )
    throw new Error('Collection status could not be verified.');
  if (value.available && value.reason !== undefined)
    throw new Error('Inconsistent collection capability.');
  const seen = new Set<string>();
  for (const option of value.collections) {
    if (
      !record(option) ||
      typeof option.id !== 'string' ||
      !/^[a-z\d-]{1,128}$/i.test(option.id) ||
      typeof option.name !== 'string' ||
      !option.name.trim() ||
      option.name.length > 512 ||
      typeof option.member !== 'boolean' ||
      seen.has(option.id)
    )
      throw new Error('Collection membership could not be verified.');
    seen.add(option.id);
  }
  return value as unknown as MediaServerCollectionsStatus;
};

const ActiveMediaServerCollectionButton = ({
  tvId,
  is4k = false,
  onLoadingChange,
}: MediaServerCollectionButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const {
    user,
    loading: userLoading,
    error: userError,
    revalidate: revalidateUser,
  } = useUser();
  const serverType = settings.currentSettings.mediaServerType;
  const server = getMediaServerName(serverType);
  const endpoint = `/api/v1/tv/${tvId}/media-server-collections`;
  const readEndpoint = `${endpoint}?is4k=${is4k}`;
  const linkedIdentity = identityKey(user);
  const context = JSON.stringify([tvId, is4k, serverType, linkedIdentity]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const [updating, setUpdating] = useState(false);
  const [failureContext, setFailureContext] = useState<string>();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const { data, error, isLoading, isValidating, mutate } = useSWR<Envelope>(
    user && !userError && server ? [readEndpoint, context, serverType] : null,
    async ([url, requestContext, requestType]: ReadKey) => ({
      context: requestContext,
      status: confirmedStatus(
        (await axios.get<unknown>(url, freshReadConfig)).data,
        requestType
      ),
    }),
    { shouldRetryOnError: false }
  );
  const status = data?.context === context ? data.status : undefined;
  const busy = userLoading || isLoading || isValidating || updating;
  const failed = !!error || !!userError || failureContext === context;
  const disabled =
    busy || failed || !user || !status?.available || !status.collections.length;
  useEffect(() => {
    setFailureContext(undefined);
  }, [context]);
  useEffect(() => {
    onLoadingChange?.(busy);
    return () => onLoadingChange?.(false);
  }, [busy, onLoadingChange]);

  const perform = async (choice?: { id: string; member: boolean }) => {
    if (inFlight.current || busy || (choice && disabled)) return;
    const actionContext = context;
    if (currentContext.current !== actionContext) return;
    inFlight.current = true;
    setUpdating(true);
    const stillCurrent = () =>
      mounted.current && currentContext.current === actionContext;
    try {
      const freshUser = await revalidateUser();
      if (!stillCurrent()) return;
      if (!freshUser || identityKey(freshUser) !== linkedIdentity)
        throw new Error('Linked account changed.');
      const freshStatus = confirmedStatus(
        (await axios.get<unknown>(readEndpoint, freshReadConfig)).data,
        serverType
      );
      if (!stillCurrent()) return;
      let confirmed = freshStatus;
      if (choice) {
        const existing = freshStatus.collections.find(
          (option) => option.id === choice.id
        );
        if (!freshStatus.available || !existing)
          throw new Error('Collection is no longer accessible.');
        // Preserve the explicitly chosen action if another client changed state.
        // Never invert fresh membership and accidentally reverse the user's intent.
        if (existing.member !== choice.member) {
          confirmed = confirmedStatus(
            (
              await axios.post<unknown>(
                `${endpoint}/${encodeURIComponent(choice.id)}`,
                { member: choice.member, is4k }
              )
            ).data,
            serverType
          );
          if (!stillCurrent()) return;
        }
        if (
          !confirmed.available ||
          confirmed.collections.find((option) => option.id === choice.id)
            ?.member !== choice.member
        )
          throw new Error('Collection update was not confirmed.');
      }
      await mutate(
        { context: actionContext, status: confirmed },
        { revalidate: false }
      );
      if (stillCurrent()) setFailureContext(undefined);
    } catch {
      if (stillCurrent()) setFailureContext(actionContext);
    } finally {
      inFlight.current = false;
      if (mounted.current) setUpdating(false);
    }
  };
  if (!server) return null;
  const reasonMessage =
    status?.reason === 'account-not-linked' || !user
      ? messages.link
      : status?.reason === 'not-authorized'
        ? messages.permission
        : status?.reason === 'series-not-found'
          ? messages.missing
          : status?.reason === 'collection-limit'
            ? messages.limit
            : messages.unavailable;
  const help = intl.formatMessage(
    busy
      ? messages.busy
      : failed
        ? messages.error
        : !status?.available
          ? reasonMessage
          : !status.collections.length
            ? messages.empty
            : messages.help,
    { server }
  );
  return (
    <>
      <Tooltip content={help}>
        <span className="app-action-row">
          <Dropdown
            buttonType="playback"
            disabled={disabled}
            disabledReason={help}
            title={help}
            aria-busy={busy}
            text={
              <>
                <MediaServerIcon
                  mediaServerType={serverType}
                  className="playback-provider-icon"
                />
                <span>{intl.formatMessage(messages.addCollection)}</span>
              </>
            }
          >
            {status?.collections.length
              ? status.collections.map((option) => (
                  <Dropdown.Item
                    key={option.id}
                    buttonType="playback"
                    aria-disabled={disabled}
                    onClick={(event) => {
                      event.preventDefault();
                      void perform({ id: option.id, member: !option.member });
                    }}
                  >
                    {intl.formatMessage(
                      option.member ? messages.removeNamed : messages.addNamed,
                      { name: option.name }
                    )}
                  </Dropdown.Item>
                ))
              : undefined}
          </Dropdown>
        </span>
      </Tooltip>
      {failed && (
        <PageErrorMessage
          title={intl.formatMessage(messages.errorTitle)}
          description={intl.formatMessage(messages.error)}
          retry={{
            tooltip: intl.formatMessage(messages.retry),
            busy,
            onClick: () => perform(),
          }}
        />
      )}
    </>
  );
};

// A disabled integration boundary renders nothing and mounts no data hooks.
const MediaServerCollectionButton = (
  props: MediaServerCollectionButtonProps
) =>
  props.enabled === false ||
  !Number.isSafeInteger(props.tvId) ||
  props.tvId < 1 ||
  props.tvId > 1_000_000_000 ||
  (props.is4k !== undefined && typeof props.is4k !== 'boolean') ? null : (
    <ActiveMediaServerCollectionButton {...props} />
  );
export default MediaServerCollectionButton;
