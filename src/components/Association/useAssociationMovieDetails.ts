import type { MovieDetails } from '@server/models/Movie';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';

// Enrich visible cards only; a long association list must not fan out a full
// metadata fetch for every item before the reader scrolls to it.
export default function useAssociationMovieDetails(id?: number) {
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!id || !ref.current) return;
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
  }, [id]);
  const { data } = useSWR<MovieDetails>(
    visible && id ? `/api/v1/movie/${id}` : null,
    (url: string) =>
      axios.get<MovieDetails>(url, { timeout: 20000 }).then(({ data }) => data),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      shouldRetryOnError: false,
    }
  );
  return { ref, data };
}
