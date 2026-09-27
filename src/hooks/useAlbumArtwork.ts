import axios from 'axios';
import { useEffect, useState, type RefObject } from 'react';
import useSWR from 'swr';

// Album posters share a small queue: scrolling through a catalogue must not
// launch hundreds of simultaneous provider requests or load full track details.
let active = 0;
const waiting: (() => void)[] = [];
export const fetchAlbumArtwork = async (
  url: string
): Promise<{ posterPath: string | null }> => {
  await new Promise<void>((resolve) => {
    const start = () => {
      active += 1;
      resolve();
    };
    if (active < 4) start();
    else waiting.push(start);
  });
  try {
    const { data } = await axios.get<{ posterPath: string | null }>(url, {
      timeout: 30000,
    });
    return data;
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
};

export default function useAlbumArtwork(
  id: string | undefined,
  posterPath: string | undefined,
  card: RefObject<HTMLElement | null>
) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!id || posterPath || !card.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [id, posterPath, card]);
  const { data } = useSWR<{ posterPath: string | null }>(
    id && !posterPath && visible
      ? `/api/v1/music/${encodeURIComponent(id)}/artwork`
      : null,
    fetchAlbumArtwork,
    {
      dedupingInterval: 300000,
      revalidateOnFocus: false,
      errorRetryCount: 2,
      errorRetryInterval: 15000,
      shouldRetryOnError: (error) =>
        !axios.isAxiosError(error) ||
        ![400, 401, 403, 404].includes(error.response?.status ?? 0),
    }
  );
  return posterPath || data?.posterPath || undefined;
}
