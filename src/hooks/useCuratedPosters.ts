import useSettings from '@app/hooks/useSettings';
import { mapWithConcurrency } from '@app/utils/concurrency';
import { getImageCacheUrl } from '@app/utils/imageCache';
import type { CuratedCollectionMember } from '@server/models/CuratedCollection';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

const BATCH_SIZE = 50;

export const preloadCuratedPoster = (url: string, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const image = new window.Image();
    const abort = () => finish(false);
    const finish = (success: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image.onload = null;
      image.onerror = null;
      resolve(success);
    };
    const timer = setTimeout(() => finish(false), 30000);
    signal.addEventListener('abort', abort, { once: true });
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = url;
  });

type PosterSnapshot = {
  scope: string;
  posters: Record<string, string | null>;
  complete: boolean;
  loading: boolean;
};

export default function useCuratedPosters(
  collectionId: string,
  parts: CuratedCollectionMember[]
) {
  const { currentSettings } = useSettings();
  const cacheImages = currentSettings.cacheImages;
  const partKey = JSON.stringify(
    parts.map(({ id, posterPath }) => [id, posterPath])
  );
  const scope = JSON.stringify([collectionId, partKey, cacheImages]);
  const retryRef = useRef<() => void>(() => undefined);
  const retry = useCallback(() => retryRef.current(), []);
  const [snapshot, setSnapshot] = useState<PosterSnapshot>({
    scope: '',
    posters: {},
    complete: false,
    loading: false,
  });
  useEffect(() => {
    if (!collectionId) return;
    const controller = new AbortController();
    const entries = JSON.parse(partKey) as [string, string | undefined][];
    const posters: Record<string, string | null> = {};
    const failed = new Set<string>();
    const paths = new Map(entries);
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = 30000;
    setSnapshot({ scope, posters: {}, complete: false, loading: false });
    const load = async (targets: typeof entries) => {
      if (loading || controller.signal.aborted) return;
      clearTimeout(timer);
      loading = true;
      setSnapshot({
        scope,
        posters: { ...posters },
        complete: false,
        loading: true,
      });
      for (let offset = 0; offset < targets.length; offset += BATCH_SIZE) {
        if (controller.signal.aborted) return;
        const batch = targets.slice(offset, offset + BATCH_SIZE);
        await mapWithConcurrency(batch, 4, async ([id, existingPath]) => {
          if (controller.signal.aborted) return;
          let posterPath = existingPath ?? null;
          if (!posterPath) {
            try {
              const response = await axios.get<{ posterPath: string | null }>(
                `/api/v1/music/${encodeURIComponent(id)}/artwork`,
                { timeout: 30000, signal: controller.signal }
              );
              posterPath = response.data.posterPath;
            } catch {
              failed.add(id);
              return;
            }
          }
          if (posterPath && !controller.signal.aborted) {
            paths.set(id, posterPath);
            const loaded = await preloadCuratedPoster(
              getImageCacheUrl({ cacheImages, src: posterPath, type: 'music' }),
              controller.signal
            );
            if (!loaded) {
              failed.add(id);
              return;
            }
          }
          failed.delete(id);
          posters[id] = posterPath;
          if (!controller.signal.aborted)
            setSnapshot({
              scope,
              posters: { ...posters },
              complete: false,
              loading: true,
            });
        });
        if (!controller.signal.aborted)
          setSnapshot({
            scope,
            posters: { ...posters },
            complete: false,
            loading: true,
          });
      }
      loading = false;
      if (!controller.signal.aborted) {
        setSnapshot({
          scope,
          posters: { ...posters },
          complete: !failed.size,
          loading: false,
        });
        if (failed.size) {
          const attempt = () => {
            if (controller.signal.aborted) return;
            if (document.hidden || window.navigator.onLine === false) {
              timer = setTimeout(attempt, 30000);
              return;
            }
            retryRef.current();
          };
          timer = setTimeout(attempt, delay);
          delay = Math.min(delay * 2, 300000);
        }
      }
    };
    retryRef.current = () => {
      if (!loading && failed.size && !controller.signal.aborted)
        void load([...failed].map((id) => [id, paths.get(id)]));
    };
    void load(entries);
    return () => {
      controller.abort();
      clearTimeout(timer);
      retryRef.current = () => undefined;
    };
  }, [scope, collectionId, partKey, cacheImages]);
  return {
    posters: snapshot.scope === scope ? snapshot.posters : {},
    complete: snapshot.scope === scope && snapshot.complete,
    loading:
      Boolean(collectionId) &&
      (snapshot.scope === scope ? snapshot.loading : parts.length > 0),
    retry,
  };
}
