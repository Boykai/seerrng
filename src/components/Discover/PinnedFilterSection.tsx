import DetailDisclosureButton from '@app/components/MediaDetails/DetailDisclosureButton';
import useDetailDisclosurePins from '@app/hooks/useDetailDisclosurePins';
import type { DetailDisclosureMediaType } from '@server/interfaces/api/userSettingsInterfaces';
import { useEffect, useState, type ReactNode } from 'react';

export default function PinnedFilterSection({
  mediaType,
  section,
  label,
  children,
}: {
  mediaType: DetailDisclosureMediaType;
  section: 'filters' | 'mediaFilters' | 'sortBy';
  label: string;
  children: ReactNode;
}) {
  const { pins, togglePinned } = useDetailDisclosurePins(mediaType);
  const [open, setOpen] = useState(false);
  const sectionPinned = Boolean(pins[section]);
  useEffect(() => setOpen(sectionPinned), [sectionPinned]);
  return (
    <section className="mt-4 mb-4">
      <div className="media-detail-disclosure-row">
        <DetailDisclosureButton
          label={label}
          open={open}
          onClick={() => setOpen((value) => !value)}
          pinned={pins[section]}
          onPinClick={() => void togglePinned(section)}
        />
      </div>
      {open && <div className="mt-3 space-y-2">{children}</div>}
    </section>
  );
}
