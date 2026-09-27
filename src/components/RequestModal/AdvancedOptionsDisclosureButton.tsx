import DetailDisclosureButton from '@app/components/MediaDetails/DetailDisclosureButton';
import { AdjustmentsHorizontalIcon } from '@heroicons/react/24/outline';

const AdvancedOptionsDisclosureButton = ({
  label,
  open,
  pinned,
  onToggle,
  onPin,
}: {
  label: string;
  open: boolean;
  pinned: boolean;
  onToggle: () => void;
  onPin: () => void;
}) => (
  <DetailDisclosureButton
    label={label}
    icon={
      <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" aria-hidden="true" />
    }
    open={open}
    onClick={onToggle}
    pinned={pinned}
    onPinClick={onPin}
  />
);

export default AdvancedOptionsDisclosureButton;
