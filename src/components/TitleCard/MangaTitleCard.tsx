import TitleCard from '@app/components/TitleCard';
import useMangaSummaries from '@app/hooks/useMangaSummaries';
import { getMangaImageUrl } from '@app/utils/mangaImages';

export interface MangaTitleCardProps {
  id: number;
  /** The AniList IDs loaded in one request with this card's title. */
  batchIds: readonly number[];
  canExpand?: boolean;
  mutateParent?: () => void;
}

/** A watchlisted manga, loaded with the other manga on its watchlist page. */
const MangaTitleCard = ({
  id,
  batchIds,
  canExpand,
  mutateParent,
}: MangaTitleCardProps) => {
  const { summaries, isLoading, error } = useMangaSummaries(batchIds);
  const manga = summaries.get(id);

  if (!manga) {
    // Unknown titles and titles hidden by the Manga Content settings are left
    // out once the batch has loaded.
    return isLoading || error ? (
      <TitleCard.Placeholder canExpand={canExpand} />
    ) : null;
  }

  return (
    <TitleCard
      id={manga.id}
      image={getMangaImageUrl(manga.posterPath)}
      status={manga.mediaInfo?.status}
      title={manga.title}
      year={manga.startYear?.toString()}
      mediaType="manga"
      isAddedToWatchlist={manga.mediaInfo?.watchlists?.length ?? true}
      canExpand={canExpand}
      mutateParent={mutateParent}
    />
  );
};

export default MangaTitleCard;
