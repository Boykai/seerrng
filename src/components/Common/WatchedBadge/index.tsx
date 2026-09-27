import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import Tooltip from '@app/components/Common/Tooltip';
import { CheckIcon } from '@heroicons/react/24/solid';
import type { WatchStatusResponse } from '@server/models/WatchStatus';

interface WatchedBadgeProps {
  status?: WatchStatusResponse;
  className?: string;
  showUnwatched?: boolean;
  incompleteLibrary?: boolean;
}

const WatchedBadge = ({
  status,
  className = '',
  showUnwatched = false,
  incompleteLibrary = false,
}: WatchedBadgeProps) => {
  if (
    !status ||
    status.availableCount === 0 ||
    (!showUnwatched && status.watchedCount === 0)
  ) {
    return null;
  }
  const serverName = getMediaServerName(status.serverType);
  if (!serverName) {
    return null;
  }
  const complete =
    status.watchedCount > 0 &&
    status.unwatchedCount === 0 &&
    !incompleteLibrary;
  const label =
    status.watchedCount === 0
      ? `Unwatched on ${serverName}`
      : complete
        ? `Watched on ${serverName}`
        : status.unwatchedCount === 0
          ? `All downloaded episodes watched, but the series is partially available on ${serverName}`
          : `${status.unwatchedCount} unwatched ${
              status.unwatchedCount === 1 ? 'episode' : 'episodes'
            } on ${serverName}`;
  return (
    <Tooltip content={label}>
      <span
        className={`poster-control watched-status-badge ${className}`}
        aria-label={label}
      >
        <MediaServerIcon
          mediaServerType={status.serverType}
          className="watched-status-logo"
        />
        {status.watchedCount === 0 ||
        (incompleteLibrary && status.unwatchedCount === 0) ? (
          <span aria-hidden="true">–</span>
        ) : complete ? (
          <CheckIcon className="watched-status-icon" aria-hidden="true" />
        ) : (
          <span aria-hidden="true">{status.unwatchedCount}</span>
        )}
      </span>
    </Tooltip>
  );
};

export default WatchedBadge;
