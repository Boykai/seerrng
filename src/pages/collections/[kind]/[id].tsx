import CuratedCollectionDetails from '@app/components/CollectionDetails/CuratedCollectionDetails';
import ErrorPage from '@app/pages/_error';
import { useRouter } from 'next/router';

export default function CollectionPage() {
  const { query, isReady } = useRouter();
  if (!isReady) return null;
  if (
    (query.kind !== 'tv' && query.kind !== 'music') ||
    typeof query.id !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(query.id)
  )
    return <ErrorPage statusCode={404} />;
  return (
    <CuratedCollectionDetails
      key={`${query.kind}:${query.id}:${query.view}`}
      kind={query.kind}
      id={query.id}
      discographyArtist={
        query.kind === 'music' && query.view === 'discography' ? '' : undefined
      }
      returnAlbumId={
        typeof query.albumId === 'string' &&
        /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(query.albumId)
          ? query.albumId
          : undefined
      }
    />
  );
}
