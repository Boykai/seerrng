import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import TrackingControls from '@app/components/DiscoveryIntegrations/TrackingControls';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import defineMessages from '@app/utils/defineMessages';
import type { DiscoveryAccountProvider } from '@server/entity/DiscoveryAccount';
import type {
  LibraryShelf,
  PersonalLibraryItem,
} from '@server/lib/discoveryIntegrations/library';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('library', {
  title: 'My Library',
  description:
    'Browse your connected tracking accounts and update your own watched status, progress, and ratings.',
  accounts: 'Manage connected accounts',
  provider: 'Library source',
  shelf: 'Shelf',
  mediaType: 'Media type',
  allTypes: 'Movies and series',
  movies: 'Movies',
  series: 'Series',
  all: 'All titles',
  watchlist: 'Watchlist',
  watched: 'Watched',
  'in-progress': 'In progress',
  completed: 'Completed',
  rated: 'Rated',
  disconnected:
    'Connect a tracking account under Linked Accounts to browse its library.',
  loading: 'Loading your library…',
  empty: 'No titles match this shelf.',
  failed:
    'Your library could not be loaded. Check the provider connection and try again.',
  retry: 'Retry',
  unmapped:
    'Some titles retain their original provider identity until a catalog match is confirmed.',
  limit:
    'This library reached its page limit. Continue browsing on the provider website.',
  previous: 'Previous page',
  next: 'Next page',
  page: 'Page {page}',
  rating: 'Your rating: {rating}/10',
  episodes: '{count} episodes watched',
  total: '{count}/{total} episodes watched',
  planning: 'Planning to watch',
  watching: 'Watching',
  watchedState: 'Watched episodes',
  completedState: 'Completed',
  paused: 'Paused',
  dropped: 'Dropped',
});
const names = { trakt: 'Trakt', anilist: 'AniList', simkl: 'Simkl' };
const base = '/api/v1/integrations/discovery';
export default function LibraryPage() {
  const intl = useIntl();
  const [provider, setProvider] = useState<DiscoveryAccountProvider>('trakt');
  const [shelf, setShelf] = useState<LibraryShelf>('watched');
  const [type, setType] = useState('movie');
  const [page, setPage] = useState(1);
  const initializedProvider = useRef(false);
  const { data: connections } = useSWR<{
    accounts: { provider: DiscoveryAccountProvider }[];
  }>(`${base}/accounts`);
  useEffect(() => {
    if (initializedProvider.current || !connections?.accounts.length) return;
    initializedProvider.current = true;
    const first = connections.accounts[0].provider;
    setProvider(first);
    setShelf(first === 'trakt' ? 'watched' : 'all');
    setType(first === 'trakt' ? 'movie' : '');
  }, [connections]);
  const connected = connections?.accounts.some(
    (account) => account.provider === provider
  );
  const { data, error, isLoading, mutate } = useSWR<{
    items: PersonalLibraryItem[];
    hasMore: boolean;
    allowWrites: boolean;
    missingMappings: number;
    truncated: boolean;
  }>(
    connected
      ? `${base}/library/${provider}?shelf=${shelf}&page=${page}${type ? `&mediaType=${type}` : ''}`
      : null,
    { revalidateOnFocus: false, dedupingInterval: 30000 }
  );
  const shelves: LibraryShelf[] =
    provider === 'trakt'
      ? ['watched', 'watchlist', 'rated']
      : ['all', 'watchlist', 'in-progress', 'completed', 'rated'];
  const statuses = {
    planning: messages.planning,
    watching: messages.watching,
    watched: messages.watchedState,
    completed: messages.completedState,
    paused: messages.paused,
    dropped: messages.dropped,
  };
  return (
    <div className="text-gray-100">
      <PageTitle title={intl.formatMessage(messages.title)} />
      <h1 className="heading">{intl.formatMessage(messages.title)}</h1>
      <p className="description mb-6">
        {intl.formatMessage(messages.description)}{' '}
        <Link
          href="/profile/settings/linked-accounts"
          className="text-blue-300"
        >
          {intl.formatMessage(messages.accounts)}
        </Link>
      </p>
      <div className="mb-6 flex flex-wrap gap-4">
        <label className="block" htmlFor="library-source">
          {intl.formatMessage(messages.provider)}
          <select
            id="library-source"
            className="mt-2 block w-full"
            value={provider}
            onChange={(event) => {
              initializedProvider.current = true;
              const source = event.target.value as DiscoveryAccountProvider;
              setProvider(source);
              setShelf(source === 'trakt' ? 'watched' : 'all');
              setType(source === 'trakt' ? 'movie' : '');
              setPage(1);
            }}
          >
            {Object.entries(names).map(([key, name]) => (
              <option key={key} value={key}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="block" htmlFor="library-shelf">
          {intl.formatMessage(messages.shelf)}
          <select
            id="library-shelf"
            className="mt-2 block w-full"
            value={shelf}
            onChange={(event) => {
              setShelf(event.target.value as LibraryShelf);
              setPage(1);
            }}
          >
            {shelves.map((value) => (
              <option key={value} value={value}>
                {intl.formatMessage(messages[value])}
              </option>
            ))}
          </select>
        </label>
        <label className="block" htmlFor="library-type">
          {intl.formatMessage(messages.mediaType)}
          <select
            id="library-type"
            className="mt-2 block w-full"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setPage(1);
            }}
          >
            {provider !== 'trakt' && (
              <option value="">{intl.formatMessage(messages.allTypes)}</option>
            )}
            <option value="movie">{intl.formatMessage(messages.movies)}</option>
            <option value="tv">{intl.formatMessage(messages.series)}</option>
          </select>
        </label>
      </div>
      {connections && !connected && (
        <p>{intl.formatMessage(messages.disconnected)}</p>
      )}
      {isLoading && <p role="status">{intl.formatMessage(messages.loading)}</p>}
      {error && (
        <div role="alert">
          <p>{intl.formatMessage(messages.failed)}</p>
          <Button onClick={() => void mutate()}>
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      )}
      {!!data?.missingMappings && (
        <p className="mb-4 text-sm text-gray-400">
          {intl.formatMessage(messages.unmapped)}
        </p>
      )}
      {data?.truncated && (
        <p role="status" className="mb-4 text-yellow-300">
          {intl.formatMessage(messages.limit)}
        </p>
      )}
      {data?.items.length === 0 && <p>{intl.formatMessage(messages.empty)}</p>}
      <div className="grid grid-cols-1 gap-4 min-[440px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {data?.items.map((item) => (
          <article
            key={item.id}
            className="min-w-0 overflow-hidden rounded-lg border border-gray-700 bg-gray-800"
          >
            {item.tmdbId && item.mediaType ? (
              <TmdbTitleCard
                id={item.tmdbId}
                tmdbId={item.tmdbId}
                type={item.mediaType}
                title={item.title}
              />
            ) : (
              <>
                {item.imageUrl && (
                  <Image
                    src={item.imageUrl.replace(
                      'https://s4.anilist.co/',
                      '/imageproxy/anilist/'
                    )}
                    width={300}
                    height={450}
                    loading="lazy"
                    unoptimized
                    alt=""
                    className="aspect-[2/3] w-full object-cover"
                  />
                )}
                <h2 className="p-3 font-semibold break-words">{item.title}</h2>
              </>
            )}
            <div className="space-y-1 px-3 pt-3 text-sm text-gray-300">
              {item.status && (
                <p>{intl.formatMessage(statuses[item.status])}</p>
              )}
              {item.rating !== undefined && (
                <p>
                  {intl.formatMessage(messages.rating, { rating: item.rating })}
                </p>
              )}
              {item.progress !== undefined && (
                <p>
                  {intl.formatMessage(
                    item.totalEpisodes !== undefined
                      ? messages.total
                      : messages.episodes,
                    { count: item.progress, total: item.totalEpisodes }
                  )}
                </p>
              )}
            </div>
            <TrackingControls
              item={item}
              allowWrites={data.allowWrites}
              onUpdated={() => mutate()}
            />
          </article>
        ))}
      </div>
      {connected && (
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            disabled={page <= 1 || isLoading}
            onClick={() => setPage((value) => value - 1)}
          >
            {intl.formatMessage(messages.previous)}
          </Button>
          <span className="text-sm">
            {intl.formatMessage(messages.page, { page })}
          </span>
          <Button
            disabled={!data?.hasMore || isLoading}
            onClick={() => setPage((value) => value + 1)}
          >
            {intl.formatMessage(messages.next)}
          </Button>
        </div>
      )}
    </div>
  );
}
