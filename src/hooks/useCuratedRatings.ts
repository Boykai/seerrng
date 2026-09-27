import { mapWithConcurrency } from '@app/utils/concurrency';
import type { RTRating } from '@server/api/rating/rottentomatoes';
import type { RatingResponse } from '@server/api/ratings';
import type { MusicRatingResponse } from '@server/models/Music';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

export type RatingFailure =
  'timeout' | 'busy' | 'authentication' | 'unavailable';
export interface CuratedRating {
  id: string;
  ratings?: RatingResponse;
  musicRating?: MusicRatingResponse['rating'];
  musicRatings?: MusicRatingResponse['ratings'];
  failure?: RatingFailure;
}

export async function loadCuratedRating(
  kind: 'tv' | 'music',
  id: string,
  signal: AbortSignal
): Promise<CuratedRating> {
  try {
    const options = { timeout: kind === 'music' ? 35000 : 20000, signal };
    if (kind === 'tv') {
      const { data } = await axios.get<RTRating>(
        `/api/v1/tv/${encodeURIComponent(id)}/ratings`,
        options
      );
      return { id, ratings: { rt: data } };
    }
    const { data } = await axios.get<MusicRatingResponse>(
      `/api/v1/music/${encodeURIComponent(id)}/rating`,
      options
    );
    return {
      id,
      musicRating: data.rating,
      musicRatings: data.ratings ?? (data.rating ? [data.rating] : []),
      ...(data.failedSources?.length
        ? { failure: 'unavailable' as const }
        : {}),
    };
  } catch (error) {
    // A confirmed absence is not a failed request and does not need retrying.
    if (axios.isAxiosError(error) && error.response?.status === 404)
      return { id };
    const status = axios.isAxiosError(error)
      ? error.response?.status
      : undefined;
    const timeout =
      axios.isAxiosError(error) &&
      ['ECONNABORTED', 'ETIMEDOUT'].includes(error.code ?? '');
    return {
      id,
      failure: timeout
        ? 'timeout'
        : status === 429
          ? 'busy'
          : status === 401 || status === 403
            ? 'authentication'
            : 'unavailable',
    };
  }
}

interface Run {
  scope: string;
  kind: 'tv' | 'music';
  controller: AbortController;
  results: Map<string, CuratedRating>;
  pending: Set<string>;
  inFlight: Set<string>;
  loading: boolean;
  retryDelay: number;
}
interface Snapshot {
  scope: string;
  members: CuratedRating[];
  loading: boolean;
}

export default function useCuratedRatings(
  kind: 'tv' | 'music',
  collectionId: string,
  ids: string[]
) {
  const scope = JSON.stringify([kind, collectionId]);
  const requestedIds = JSON.stringify([...new Set(ids)]);
  const active = useRef<Run | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>({
    scope: '',
    members: [],
    loading: false,
  });
  const load = useCallback(async (run: Run, targets: string[]) => {
    if (run.controller.signal.aborted) return;
    targets.forEach((id) => {
      if (!run.inFlight.has(id)) run.pending.add(id);
    });
    // A synchronous lock also catches double clicks before React re-renders.
    if (run.loading || !run.pending.size) return;
    run.loading = true;
    const publish = () => {
      if (!run.controller.signal.aborted && active.current === run) {
        setSnapshot({
          scope: run.scope,
          members: [...run.results.values()],
          loading: run.loading,
        });
      }
    };
    publish();
    try {
      while (run.pending.size && !run.controller.signal.aborted) {
        const batch = [...run.pending].slice(0, 50);
        batch.forEach((id) => run.pending.delete(id));
        batch.forEach((id) => run.inFlight.add(id));
        await mapWithConcurrency(batch, 3, async (id) => {
          if (run.controller.signal.aborted) return;
          const member = await loadCuratedRating(
            run.kind,
            id,
            run.controller.signal
          );
          if (run.controller.signal.aborted) return;
          const previous = run.results.get(id);
          if (member.failure && previous) {
            member.musicRating ??= previous.musicRating;
            member.musicRatings = [
              ...new Map(
                [
                  ...(previous.musicRatings ?? []),
                  ...(member.musicRatings ?? []),
                ].map((rating) => [rating.source, rating])
              ).values(),
            ];
          }
          run.results.set(id, member);
          run.inFlight.delete(id);
          publish();
        });
      }
    } finally {
      run.loading = false;
      publish();
    }
  }, []);
  useEffect(() => {
    const [runKind] = JSON.parse(scope) as ['tv' | 'music', string];
    const run: Run = {
      scope,
      kind: runKind,
      controller: new AbortController(),
      results: new Map(),
      pending: new Set(),
      inFlight: new Set(),
      loading: false,
      retryDelay: 30000,
    };
    active.current = run;
    setSnapshot({ scope, members: [], loading: false });
    return () => run.controller.abort();
  }, [scope]);
  useEffect(() => {
    const run = active.current;
    if (!run || run.scope !== scope) return;
    const targets = (JSON.parse(requestedIds) as string[]).filter(
      (id) =>
        !run.results.has(id) && !run.pending.has(id) && !run.inFlight.has(id)
    );
    void load(run, targets);
  }, [scope, requestedIds, load]);
  useEffect(() => {
    const run = active.current;
    if (
      !run ||
      run.scope !== scope ||
      snapshot.scope !== scope ||
      snapshot.loading ||
      !snapshot.members.some((member) => member.failure)
    )
      return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = () => {
      if (run.controller.signal.aborted || active.current !== run) return;
      // Background tabs and offline browsers should not keep contacting providers.
      if (document.hidden || window.navigator.onLine === false) {
        timer = setTimeout(attempt, 30000);
        return;
      }
      run.retryDelay = Math.min(run.retryDelay * 2, 300000);
      void load(
        run,
        [...run.results.values()]
          .filter((member) => member.failure)
          .map((member) => member.id)
      );
    };
    timer = setTimeout(attempt, run.retryDelay);
    return () => clearTimeout(timer);
  }, [scope, snapshot, load]);
  const retry = useCallback(() => {
    const run = active.current;
    if (!run || run.scope !== scope) return;
    return load(
      run,
      [...run.results.values()]
        .filter((member) => member.failure)
        .map((member) => member.id)
    );
  }, [scope, load]);
  return {
    members: snapshot.scope === scope ? snapshot.members : [],
    loading: snapshot.scope === scope ? snapshot.loading : ids.length > 0,
    complete:
      snapshot.scope === scope &&
      (JSON.parse(requestedIds) as string[]).every((id) =>
        snapshot.members.some((member) => member.id === id && !member.failure)
      ),
    retry,
  };
}
