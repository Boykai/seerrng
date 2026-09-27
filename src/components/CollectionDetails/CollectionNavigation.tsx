import Button from '@app/components/Common/Button';
import DetailDisclosureButton from '@app/components/MediaDetails/DetailDisclosureButton';
import useDetailDisclosurePins from '@app/hooks/useDetailDisclosurePins';
import defineMessages from '@app/utils/defineMessages';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import CollectionSummaryCard from './CollectionSummaryCard';

const messages = defineMessages('components.CollectionNavigation', {
  view: 'Collection',
  artist: '{artist} Collection',
  loading: 'Checking for collections…',
  failed: 'The collection provider could not be reached.',
  retry: 'Retry',
});

export default function CollectionNavigation({
  kind,
  id,
  artistName,
}: {
  kind: 'tv' | 'music';
  id: string;
  artistName?: string;
}) {
  const intl = useIntl();
  const { pins, togglePinned } = useDetailDisclosurePins(kind);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(pins.collection);
  }, [id, pins.collection]);
  const { data, error, mutate } = useSWR<{
    collections: { id: number; name: string }[];
  }>(
    kind === 'tv' && id
      ? `/api/v1/collection-catalog/tv/for-series/${encodeURIComponent(id)}`
      : null,
    { revalidateOnFocus: false }
  );
  const collections =
    kind === 'music'
      ? [
          {
            id,
            name: intl.formatMessage(messages.artist, {
              artist: artistName ?? '',
            }),
          },
        ]
      : data?.collections;
  if (!id || collections?.length === 0) return null;
  return (
    <>
      <DetailDisclosureButton
        label={intl.formatMessage(messages.view)}
        open={open}
        onClick={() => setOpen((value) => !value)}
        pinned={pins.collection}
        onPinClick={() => void togglePinned('collection')}
        controls={`collection-navigation-${kind}`}
      />
      {open && (
        <section
          id={`collection-navigation-${kind}`}
          className="collection-navigation-panel"
        >
          {collections?.map((collection) => (
            <CollectionSummaryCard
              key={collection.id}
              kind={kind}
              collection={collection}
            />
          ))}
          {!collections && (
            <p>
              {intl.formatMessage(error ? messages.failed : messages.loading)}
            </p>
          )}
          {error && (
            <Button onClick={() => void mutate()}>
              {intl.formatMessage(messages.retry)}
            </Button>
          )}
        </section>
      )}
    </>
  );
}
