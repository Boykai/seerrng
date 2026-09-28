import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import discoveryMessages from '@app/components/DiscoveryIntegrations/messages';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import type { DiscoveryFeedPage } from '@server/lib/discoveryIntegrations/feeds';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { FormattedMessage } from 'react-intl';
import useSWR from 'swr';

const feeds = [
  'trakt/watchlist',
  'trakt/history',
  'trakt/recommendations-movie',
  'trakt/recommendations-tv',
  'anilist/trending',
  'anilist/popular',
  'anilist/top',
  'anilist/next-season',
  'anilist/library',
  'mdblist/list',
] as const;
const labels = [
  'Trakt watchlist',
  'Trakt history',
  'Trakt movie recommendations',
  'Trakt series recommendations',
  'AniList trending anime',
  'AniList popular anime',
  'AniList top anime',
  'AniList next season',
  'Your AniList library',
  'MDBList public list',
];
export default function ProviderDiscoverPage() {
  const [feed, setFeed] = useState<string>('anilist/trending');
  const [page, setPage] = useState(1);
  const [draftList, setDraftList] = useState('');
  const [list, setList] = useState('');
  const url =
    feed !== 'mdblist/list' || list
      ? `/api/v1/integrations/discovery/feeds/${feed}?page=${page}${feed === 'mdblist/list' ? `&list=${encodeURIComponent(list)}` : ''}`
      : null;
  const { data, error, isLoading, mutate } = useSWR<DiscoveryFeedPage>(url, {
    revalidateOnFocus: false,
    dedupingInterval: 30000,
  });
  return (
    <div className="text-gray-100">
      <PageTitle title="Provider Discovery" />
      <h1 className="heading">
        <FormattedMessage {...discoveryMessages['providers.title']} />
      </h1>
      <p className="description mb-6">
        <FormattedMessage {...discoveryMessages['providers.description']} />{' '}
        <Link
          className="text-blue-400"
          href="/profile/settings/linked-accounts"
        >
          <FormattedMessage {...discoveryMessages['providers.manage']} />
        </Link>
      </p>
      <label htmlFor="provider-feed" className="mb-2 block">
        <FormattedMessage {...discoveryMessages['providers.feed']} />
      </label>
      <select
        id="provider-feed"
        className="mb-6 w-full sm:w-auto"
        value={feed}
        onChange={(event) => {
          setFeed(event.target.value);
          setPage(1);
        }}
      >
        {feeds.map((value, index) => (
          <option key={value} value={value}>
            {labels[index]}
          </option>
        ))}
      </select>
      {feed === 'mdblist/list' && (
        <form
          className="mb-6 flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setList(draftList.trim());
            setPage(1);
          }}
        >
          <label htmlFor="mdblist-reference" className="flex-1">
            <FormattedMessage {...discoveryMessages['providers.list']} />
            <input
              id="mdblist-reference"
              className="mt-2 w-full"
              maxLength={2048}
              value={draftList}
              onChange={(event) => setDraftList(event.target.value)}
            />
          </label>
          <Button type="submit" disabled={!draftList.trim()}>
            <FormattedMessage {...discoveryMessages['providers.browse']} />
          </Button>
        </form>
      )}
      {error && (
        <div role="alert" className="mb-6 rounded-lg border border-red-500 p-4">
          <FormattedMessage {...discoveryMessages['providers.failed']} />{' '}
          <Button onClick={() => void mutate()}>
            <FormattedMessage {...discoveryMessages['providers.retry']} />
          </Button>
        </div>
      )}
      {isLoading && (
        <p role="status">
          <FormattedMessage {...discoveryMessages['providers.loading']} />
        </p>
      )}
      {data?.items.length === 0 && (
        <p>
          <FormattedMessage {...discoveryMessages['providers.empty']} />
        </p>
      )}
      {!!data?.missingMappings && (
        <p className="mb-4 text-sm text-gray-400">
          <FormattedMessage {...discoveryMessages['providers.unmapped']} />
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {data?.items.map((item) =>
          item.tmdbId && item.mediaType ? (
            <TmdbTitleCard
              key={item.id}
              id={item.tmdbId}
              tmdbId={item.tmdbId}
              type={item.mediaType}
              title={item.title}
            />
          ) : (
            <article
              key={item.id}
              className="overflow-hidden rounded-lg border border-gray-700 bg-gray-800"
            >
              {item.imageUrl && (
                <Image
                  src={item.imageUrl.replace(
                    'https://s4.anilist.co/',
                    '/imageproxy/anilist/'
                  )}
                  width={300}
                  height={450}
                  unoptimized
                  alt=""
                  loading="lazy"
                  className="aspect-[2/3] w-full object-cover"
                />
              )}
              <div className="p-3">
                <h2 className="font-semibold text-gray-100">{item.title}</h2>
                {item.year && (
                  <p className="text-sm text-gray-400">{item.year}</p>
                )}
                <p className="mt-2 text-xs text-gray-400">
                  <FormattedMessage
                    {...discoveryMessages['providers.matchpending']}
                  />
                </p>
              </div>
            </article>
          )
        )}
      </div>
      {data && (
        <nav
          aria-label="Discovery feed pages"
          className="my-6 flex items-center justify-between gap-4"
        >
          <Button
            disabled={page === 1 || isLoading}
            onClick={() => setPage((current) => current - 1)}
          >
            <FormattedMessage {...discoveryMessages['providers.previous']} />
          </Button>
          <span>
            <FormattedMessage
              {...discoveryMessages['providers.page']}
              values={{ page }}
            />
          </span>
          <Button
            disabled={!data.hasMore || page >= 100 || isLoading}
            onClick={() => setPage((current) => current + 1)}
          >
            <FormattedMessage {...discoveryMessages['providers.next']} />
          </Button>
        </nav>
      )}
    </div>
  );
}
