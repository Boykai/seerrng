import useDetailDisclosurePins from '@app/hooks/useDetailDisclosurePins';
import type { DetailDisclosureMediaType } from '@server/interfaces/api/userSettingsInterfaces';
import { useEffect, useState } from 'react';

const useAdvancedOptionsDisclosure = (mediaType: DetailDisclosureMediaType) => {
  const { pins, togglePinned } = useDetailDisclosurePins(mediaType);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setOpen(pins.advancedOptions);
  }, [pins.advancedOptions]);

  return {
    open,
    pinned: pins.advancedOptions,
    toggleOpen: () => setOpen((value) => !value),
    togglePin: () => void togglePinned('advancedOptions'),
  };
};

export default useAdvancedOptionsDisclosure;
