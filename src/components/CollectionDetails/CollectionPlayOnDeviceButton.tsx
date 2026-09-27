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

const messages = defineMessages('components.CollectionDetails.PlayOnDevice', {
  label: 'Play on Device',
  emptySelection: 'No playable items are currently available.',
  noDevices: 'No active, authorized playback devices are available.',
  started: 'Playback started on {deviceName}.',
  failed: 'Playback could not be started on {deviceName}.',
});

const CollectionPlayOnDeviceButton = ({
  mediaIds,
  is4k = false,
  disabledReason: reason,
}: {
  mediaIds: number[];
  is4k?: boolean;
  disabledReason?: string;
}) => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const [activeDeviceId, setActiveDeviceId] = useState<string>();
  const { data: devices, error } = useSWR<PlaybackDevice[]>(
    '/api/v1/playback/devices',
    { refreshInterval: 30_000 }
  );
  const selectedMediaIds = [...new Set(mediaIds)].filter(Number.isSafeInteger);
  const disabledReason =
    reason ??
    (selectedMediaIds.length === 0
      ? intl.formatMessage(messages.emptySelection)
      : error || (devices && devices.length === 0)
        ? intl.formatMessage(messages.noDevices)
        : undefined);

  const startPlayback = async (device: PlaybackDevice) => {
    if (activeDeviceId || selectedMediaIds.length === 0) return;
    setActiveDeviceId(device.id);
    try {
      await axios.post('/api/v1/playback/collection/play', {
        deviceId: device.id,
        mediaIds: selectedMediaIds,
        is4k,
      });
      addToast(
        intl.formatMessage(messages.started, { deviceName: device.name }),
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(
        intl.formatMessage(messages.failed, { deviceName: device.name }),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    } finally {
      setActiveDeviceId(undefined);
    }
  };

  return (
    <Dropdown
      buttonType="playback"
      buttonSize="sm"
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
      {selectedMediaIds.length > 0 && (devices?.length ?? 0) > 0
        ? (devices ?? []).map((device) => (
            <Dropdown.Item
              key={device.id}
              buttonType="playback"
              aria-disabled={!!activeDeviceId}
              onClick={(event) => {
                event.preventDefault();
                void startPlayback(device);
              }}
            >
              <ComputerDesktopIcon className="mr-2 h-4 w-4 flex-none" />
              <span className="min-w-0">
                <span className="block truncate">{device.name}</span>
                <span className="block truncate text-xs text-gray-500">
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

export default CollectionPlayOnDeviceButton;
