import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import type { PersonalLibraryItem } from '@server/lib/discoveryIntegrations/library';
import type { MovieResult, TvResult } from '@server/models/Search';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.IdentityMappingControls', {
  match: 'Match catalog title',
  change: 'Change title match',
  reset: 'Reset title match',
  searchLabel: 'Search SeerrNG catalog',
  movie: 'Movie',
  series: 'Series',
  searching: 'Searching…',
  searchHint: 'Enter at least two characters.',
  searchFailed: 'The catalog search failed. Try again.',
  noResults: 'No matching titles were found.',
  useMatch: 'Use this match',
  saved: 'Title match saved.',
  saveFailed: 'The match could not be saved. Try again.',
  resetSaved: 'Title match reset.',
  resetFailed: 'The match could not be reset. Try again.',
});

type MappingSearchResult =
  | Pick<MovieResult, 'id' | 'mediaType' | 'title'>
  | Pick<TvResult, 'id' | 'mediaType' | 'name'>;

type MappingSearchResponse = {
  results: MappingSearchResult[];
};

export default function IdentityMappingControls({
  item,
  onUpdated,
}: {
  item: PersonalLibraryItem;
  onUpdated: () => Promise<unknown>;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(item.title);
  const [searchQuery, setSearchQuery] = useState('');
  const [mediaType, setMediaType] = useState<'movie' | 'tv'>(
    item.mediaType ?? 'movie'
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!open) return;
    const timeout = setTimeout(() => setSearchQuery(query.trim()), 300);
    return () => clearTimeout(timeout);
  }, [open, query]);

  const searchUrl =
    open && searchQuery.length >= 2
      ? `/api/v1/search?query=${encodeURIComponent(searchQuery)}&type=${mediaType}&page=1`
      : null;
  const { data, error, isLoading } = useSWR<MappingSearchResponse>(searchUrl, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
  });

  const save = async (target: { id: number; mediaType: 'movie' | 'tv' }) => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await axios.put('/api/v1/integrations/discovery/mappings', {
        identity: item.id,
        tmdbId: target.id,
        mediaType: target.mediaType,
      });
      setNotice(intl.formatMessage(messages.saved));
      setOpen(false);
      await onUpdated();
    } catch {
      setNotice(intl.formatMessage(messages.saveFailed));
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    setNotice('');
    try {
      await axios.delete(
        `/api/v1/integrations/discovery/mappings/${encodeURIComponent(item.id)}`
      );
      setNotice(intl.formatMessage(messages.resetSaved));
      await onUpdated();
    } catch {
      setNotice(intl.formatMessage(messages.resetFailed));
    } finally {
      setBusy(false);
    }
  };

  const results = (data?.results ?? []).filter(
    (result) => result.mediaType === mediaType
  );

  return (
    <div className="space-y-2 px-3 pt-3">
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy} onClick={() => setOpen((value) => !value)}>
          {intl.formatMessage(
            item.identityMapped ? messages.change : messages.match
          )}
        </Button>
        {item.identityMapped && (
          <Button disabled={busy} onClick={() => void reset()}>
            {intl.formatMessage(messages.reset)}
          </Button>
        )}
      </div>
      {open && (
        <div className="space-y-2 rounded-md border border-gray-700 p-3">
          <label className="block text-xs" htmlFor={`mapping-type-${item.id}`}>
            {intl.formatMessage(messages.searchLabel)}
            <select
              id={`mapping-type-${item.id}`}
              className="mt-1 block w-full"
              value={mediaType}
              disabled={busy}
              onChange={(event) =>
                setMediaType(event.target.value as 'movie' | 'tv')
              }
            >
              <option value="movie">
                {intl.formatMessage(messages.movie)}
              </option>
              <option value="tv">{intl.formatMessage(messages.series)}</option>
            </select>
          </label>
          <input
            className="block w-full"
            type="search"
            aria-label={intl.formatMessage(messages.searchLabel)}
            value={query}
            disabled={busy}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.trim().length < 2 && (
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.searchHint)}
            </p>
          )}
          {isLoading && searchQuery.length >= 2 && (
            <p role="status" className="text-xs text-gray-400">
              {intl.formatMessage(messages.searching)}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {intl.formatMessage(messages.searchFailed)}
            </p>
          )}
          {data && !isLoading && results.length === 0 && (
            <p className="text-xs text-gray-400">
              {intl.formatMessage(messages.noResults)}
            </p>
          )}
          <ul className="space-y-2">
            {results.slice(0, 8).map((result) => {
              const title = 'title' in result ? result.title : result.name;
              return (
                <li
                  key={`${result.mediaType}:${result.id}`}
                  className="flex flex-wrap items-center justify-between gap-2 text-sm"
                >
                  <span>{title}</span>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void save({ id: result.id, mediaType: result.mediaType })
                    }
                  >
                    {intl.formatMessage(messages.useMatch)}
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {notice && (
        <p role="status" className="text-xs text-gray-300">
          {notice}
        </p>
      )}
    </div>
  );
}
