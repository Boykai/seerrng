import type { AssociationNode } from '@app/hooks/useAssociations';
import type { RatingResponse } from '@server/api/ratings';
import type { MusicRatingResponse } from '@server/models/Music';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

export default function useAssociationRatings(node: AssociationNode) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [node.id, node.mediaType]);
  const videoKey =
    visible && node.mediaType === 'tv'
      ? '/api/v1/tv/' + encodeURIComponent(String(node.id)) + '/ratings'
      : null;
  const albumKey =
    visible && node.mediaType === 'album'
      ? '/api/v1/music/' + encodeURIComponent(node.id) + '/rating'
      : null;
  const options = {
    revalidateOnFocus: false,
    dedupingInterval: 300000,
    shouldRetryOnError: false,
  };
  const { data: videoRatings } = useSWR<RatingResponse>(
    videoKey,
    (url: string) =>
      axios
        .get<RatingResponse>(url, { timeout: 20000 })
        .then(({ data }) => data),
    options
  );
  const { data: albumRatings } = useSWR<MusicRatingResponse>(
    albumKey,
    (url: string) =>
      axios
        .get<MusicRatingResponse>(url, { timeout: 35000 })
        .then(({ data }) => data),
    options
  );
  return { ref, videoRatings, albumRatings };
}
