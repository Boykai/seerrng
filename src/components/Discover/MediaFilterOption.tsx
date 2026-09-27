import { getFilterToggleButtonClass } from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import { PushPinIcon } from '@app/components/MediaDetails/DetailDisclosureButton';
import type useMediaFilterPin from '@app/hooks/useMediaFilterPin';
import defineMessages from '@app/utils/defineMessages';
import type { MediaFilterValue } from '@server/interfaces/api/userSettingsInterfaces';
import type { ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.MediaFilterOption', {
  pin: 'Pin {label}',
  unpin: 'Unpin {label}',
  failed: 'Could not save the media filter pin. Please try again.',
});

export default function MediaFilterOption<T extends MediaFilterValue>({
  pin,
  value,
  label,
  selected,
  children,
}: {
  pin: ReturnType<typeof useMediaFilterPin<T>>;
  value: T;
  label: string;
  selected: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const pinned = pin.pinnedValue === value;
  const pinLabel = intl.formatMessage(pinned ? messages.unpin : messages.pin, {
    label,
  });
  return (
    <span className={`${getFilterToggleButtonClass(selected)} !gap-0 !p-0`}>
      <button
        type="button"
        className="app-control-shadow-exempt app-filter-segment-focus flex h-full items-center border-r border-current/30 px-2"
        aria-label={pinLabel}
        title={pinLabel}
        aria-pressed={pinned}
        disabled={!pin.available || pin.busy}
        onClick={() => pin.toggle(value)}
      >
        <PushPinIcon
          filled={pinned}
          className="h-3.5 w-3.5 rotate-45"
          aria-hidden="true"
        />
      </button>
      {children}
      {pin.error && selected && (
        <span className="sr-only" role="alert">
          {intl.formatMessage(messages.failed)}
        </span>
      )}
    </span>
  );
}
