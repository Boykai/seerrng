import Dropdown from '@app/components/Common/Dropdown';
import MediaServerIcon from '@app/components/Common/MediaServerIcon';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { ComputerDesktopIcon } from '@heroicons/react/24/outline';
import type { PlaybackDevice } from '@server/models/Playback';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Common.PlayOnDeviceButton', {
  label: 'Play on Device',
  help: 'Choose an active, authorized device and start playing the selected media on it.',
  emptySelection: 'No playable media is currently available.',
  noDevices: 'No active, authorized playback devices are available.',
  started: 'Playback started on {deviceName}.',
  failed: 'Playback could not be started on {deviceName}.',
});

interface PlayOnDeviceButtonProps {
  mediaId?: number;
  itemIds: string[];
  unavailableReason?: string;
  is4k?: boolean;
  className?: string;
}

const PlayOnDeviceButton = ({
  mediaId,
  itemIds,
  unavailableReason,
  is4k = false,
  className,
}: PlayOnDeviceButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const [activeDeviceId, setActiveDeviceId] = useState<string>();
  const { data: devices, error } = useSWR<PlaybackDevice[]>(
    mediaId ? '/api/v1/playback/devices' : null,
    { refreshInterval: 30_000 }
  );
  const selectedItemIds = [...new Set(itemIds)].filter(Boolean);
  const canPlay = !!mediaId && selectedItemIds.length > 0;
  const availableDevices = canPlay ? (devices ?? []) : [];
  const disabledReason = !canPlay
    ? (unavailableReason ?? intl.formatMessage(messages.emptySelection))
    : error || (devices && devices.length === 0)
      ? intl.formatMessage(messages.noDevices)
      : undefined;

  const startPlayback = async (device: PlaybackDevice) => {
    if (!mediaId || activeDeviceId) {
      return;
    }
    setActiveDeviceId(device.id);
    try {
      await axios.post(`/api/v1/playback/media/${mediaId}/play`, {
        deviceId: device.id,
        itemIds: selectedItemIds,
        is4k,
      });
      addToast(
        intl.formatMessage(messages.started, { deviceName: device.name }),
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(
        intl.formatMessage(messages.failed, { deviceName: device.name }),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setActiveDeviceId(undefined);
    }
  };

  return (
    <Dropdown
      title={intl.formatMessage(messages.help)}
      buttonType="playback"
      buttonSize="sm"
      className={className}
      disabledReason={disabledReason}
      text={
        <span className="playback-button-label">
          <MediaServerIcon
            mediaServerType={settings.currentSettings.mediaServerType}
            className="playback-provider-icon"
          />
          {intl.formatMessage(messages.label)}
        </span>
      }
    >
      {availableDevices.length > 0
        ? availableDevices.map((device) => (
            <Dropdown.Item
              key={device.id}
              buttonType="playback"
              aria-disabled={!!activeDeviceId}
              onClick={(event) => {
                event.preventDefault();
                void startPlayback(device);
              }}
            >
              <ComputerDesktopIcon className="h-4 w-4 flex-none" />
              <span className="playback-device-label">
                <span className="playback-device-name">{device.name}</span>
                <span className="playback-device-description">
                  {device.client}
                  {device.platform ? ` · ${device.platform}` : ''}
                </span>
              </span>
            </Dropdown.Item>
          ))
        : null}
    </Dropdown>
  );
};

export default PlayOnDeviceButton;
