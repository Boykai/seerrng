import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import PlayButton, {
  type PlayButtonLink,
} from '@app/components/Common/PlayButton';
import useDeepLinks from '@app/hooks/useDeepLinks';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { getSafeHref } from '@app/utils/safeUrl';
import type { PlaybackPlaylistResponse } from '@server/models/Playback';
import axios from 'axios';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.MediaServerPlayButton', {
  playOnServer: 'Play on {mediaServerName}',
  playHelp: 'Open this media in your media server to play it.',
  movieHelp: 'Open this movie in your media server to play it.',
  playlistHelp:
    'Create a playback playlist from the selected items and open it in your media server.',
  playOnServer4k: 'Play on {mediaServerName} (4K)',
  unavailable: 'No playable media is currently available on {mediaServerName}.',
  failed: 'The selected items could not be opened on {mediaServerName}.',
});

interface MediaServerPlayButtonProps {
  mediaUrl?: string;
  mediaUrl4k?: string;
  iOSPlexUrl?: string;
  iOSPlexUrl4k?: string;
  mediaId?: number;
  itemIds?: string[];
  collectionMediaIds?: number[];
  defaultIs4k?: boolean;
  include4k?: boolean;
  buttonSize?: 'default' | 'sm';
  disabled?: boolean;
  disabledReason?: string;
  context?: 'movie' | 'selection';
}

const MediaServerPlayButton = ({
  mediaUrl,
  mediaUrl4k,
  iOSPlexUrl,
  iOSPlexUrl4k,
  mediaId,
  itemIds = [],
  collectionMediaIds = [],
  defaultIs4k = false,
  include4k = false,
  buttonSize = 'sm',
  disabled = false,
  disabledReason,
  context = 'selection',
}: MediaServerPlayButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const [isOpening, setIsOpening] = useState(false);
  const isOpeningRef = useRef(false);
  const { mediaUrl: resolvedMediaUrl, mediaUrl4k: resolvedMediaUrl4k } =
    useDeepLinks({ mediaUrl, mediaUrl4k, iOSPlexUrl, iOSPlexUrl4k });
  const mediaServerType = settings.currentSettings.mediaServerType;
  const mediaServerName = getMediaServerName(mediaServerType);
  const selectedItemIds = [...new Set(itemIds)].filter(Boolean);
  const selectedMediaIds = [...new Set(collectionMediaIds)].filter(
    (candidate) => Number.isSafeInteger(candidate) && candidate > 0
  );
  const hasPlaylistRequest =
    (!!mediaId && selectedItemIds.length > 0) || selectedMediaIds.length > 0;

  if (!mediaServerName) {
    return null;
  }

  const icon = (
    <MediaServerIcon
      mediaServerType={mediaServerType}
      className="playback-provider-icon"
    />
  );
  const label = intl.formatMessage(messages.playOnServer, { mediaServerName });

  const replacePlaylistAndOpen = async (is4k: boolean) => {
    if (disabled || isOpeningRef.current || !hasPlaylistRequest) {
      return;
    }

    isOpeningRef.current = true;
    // Keep a synchronous popup handle so the eventual playlist navigation is
    // not blocked after the API request, while avoiding a reusable target.
    const popup = window.open('', `seerr-playback-${crypto.randomUUID()}`);
    if (popup) {
      popup.opener = null;
    }
    setIsOpening(true);
    try {
      const response = selectedMediaIds.length
        ? await axios.post<PlaybackPlaylistResponse>(
            '/api/v1/playback/collection/playlist',
            { mediaIds: selectedMediaIds, is4k }
          )
        : await axios.post<PlaybackPlaylistResponse>(
            `/api/v1/playback/media/${mediaId}/playlist`,
            { itemIds: selectedItemIds, is4k }
          );
      const safeUrl = getSafeHref(response.data.url);
      if (!safeUrl) {
        throw new Error('The media server returned an unsafe playlist URL.');
      }
      if (popup) {
        popup.location.replace(safeUrl);
      } else {
        window.open(safeUrl, '_blank', 'noopener,noreferrer');
      }
    } catch {
      popup?.close();
      addToast(intl.formatMessage(messages.failed, { mediaServerName }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      isOpeningRef.current = false;
      setIsOpening(false);
    }
  };

  if (hasPlaylistRequest || disabled) {
    const effectiveDisabled = disabled || isOpening || !hasPlaylistRequest;
    return (
      <ButtonWithDropdown
        title={intl.formatMessage(
          context === 'movie' ? messages.movieHelp : messages.playlistHelp
        )}
        buttonType="playback"
        buttonSize={buttonSize}
        text={
          <span className="playback-button-label">
            {icon}
            <span>{label}</span>
          </span>
        }
        disabled={effectiveDisabled}
        disabledReason={
          disabledReason ??
          intl.formatMessage(messages.unavailable, { mediaServerName })
        }
        onClick={() => void replacePlaylistAndOpen(defaultIs4k)}
      />
    );
  }

  const links: PlayButtonLink[] = [];
  if (resolvedMediaUrl) {
    links.push({ text: label, url: resolvedMediaUrl, svg: icon });
  }
  if (include4k && resolvedMediaUrl4k) {
    links.push({
      text: intl.formatMessage(messages.playOnServer4k, { mediaServerName }),
      url: resolvedMediaUrl4k,
      svg: icon,
    });
  }

  return (
    <PlayButton
      tooltip={intl.formatMessage(
        context === 'movie' ? messages.movieHelp : messages.playHelp
      )}
      links={links}
      buttonSize={buttonSize}
      unavailableLink={{ text: label, svg: icon }}
      disabledReason={
        disabledReason ??
        intl.formatMessage(messages.unavailable, { mediaServerName })
      }
    />
  );
};

export default MediaServerPlayButton;
