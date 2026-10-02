import Button from '@app/components/Common/Button';
import discoveryMessages from '@app/components/DiscoveryIntegrations/messages';
import Slider from '@app/components/Slider';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import { useUser } from '@app/hooks/useUser';
import { getDiscoveryFeedFailure } from '@app/utils/discoveryFeedError';
import axios from 'axios';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedMessage, useIntl } from 'react-intl';
import useSWR from 'swr';

const base = '/api/v1/integrations/discovery';

type Provider = 'trakt' | 'anilist' | 'simkl';
type ProviderAccount = { provider: Provider };
type ProviderAccountsResponse = { accounts: ProviderAccount[] };
type ProviderTitle = {
  id: string;
  title: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  year?: number;
  imageUrl?: string;
};
type ProviderTitlesResponse = { items: ProviderTitle[] };
type PersonalRow = {
  id: string;
  provider: Provider;
  title: (typeof discoveryMessages)[keyof typeof discoveryMessages];
  endpoint: string;
};

const providerNames: Record<Provider, string> = {
  trakt: 'Trakt',
  anilist: 'AniList',
  simkl: 'Simkl',
};

const rows: PersonalRow[] = [
  {
    id: 'trakt-recommended-movies',
    provider: 'trakt',
    title: discoveryMessages['personalized.traktMovies'],
    endpoint: `${base}/feeds/trakt/recommendations-movie?page=1`,
  },
  {
    id: 'trakt-recommended-series',
    provider: 'trakt',
    title: discoveryMessages['personalized.traktSeries'],
    endpoint: `${base}/feeds/trakt/recommendations-tv?page=1`,
  },
  {
    id: 'trakt-watchlist',
    provider: 'trakt',
    title: discoveryMessages['personalized.traktWatchlist'],
    endpoint: `${base}/feeds/trakt/watchlist?page=1`,
  },
  {
    id: 'anilist-watching',
    provider: 'anilist',
    title: discoveryMessages['personalized.anilistWatching'],
    endpoint: `${base}/library/anilist?shelf=in-progress&page=1`,
  },
  {
    id: 'anilist-planning',
    provider: 'anilist',
    title: discoveryMessages['personalized.anilistPlanning'],
    endpoint: `${base}/library/anilist?shelf=watchlist&page=1`,
  },
  {
    id: 'simkl-watching',
    provider: 'simkl',
    title: discoveryMessages['personalized.simklWatching'],
    endpoint: `${base}/library/simkl?shelf=in-progress&page=1`,
  },
  {
    id: 'simkl-planning',
    provider: 'simkl',
    title: discoveryMessages['personalized.simklPlanning'],
    endpoint: `${base}/library/simkl?shelf=watchlist&page=1`,
  },
];

const imageProxyUrl = (imageUrl?: string) =>
  imageUrl?.startsWith('https://s4.anilist.co/')
    ? imageUrl.replace('https://s4.anilist.co/', '/imageproxy/anilist/')
    : undefined;

function ProviderTitleCard({ item }: { item: ProviderTitle }) {
  if (item.tmdbId && item.mediaType) {
    return (
      <TmdbTitleCard
        id={item.tmdbId}
        tmdbId={item.tmdbId}
        type={item.mediaType}
        title={item.title}
        posterPath={item.imageUrl}
        year={item.year?.toString()}
      />
    );
  }

  const image = imageProxyUrl(item.imageUrl);

  return (
    <article
      className="w-48 overflow-hidden rounded-xl bg-gray-800 ring-1 ring-gray-700 md:w-56"
      data-testid="personal-discovery-unmatched-card"
    >
      <div className="relative aspect-[2/3] bg-gray-700">
        {image ? (
          <Image
            src={image}
            width={300}
            height={450}
            unoptimized
            alt={item.title}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-gray-300">
            {item.title}
          </div>
        )}
      </div>
      <div className="p-3 whitespace-normal">
        <h3 className="line-clamp-2 font-semibold text-gray-100">
          {item.title}
        </h3>
        {item.year && <p className="text-sm text-gray-400">{item.year}</p>}
        <p className="mt-2 text-xs text-gray-400">
          <FormattedMessage {...discoveryMessages['providers.matchpending']} />
        </p>
      </div>
    </article>
  );
}

function PersonalizedRow({
  row,
  userId,
}: {
  row: PersonalRow;
  userId: number;
}) {
  const intl = useIntl();
  const { ref, inView } = useInView({
    rootMargin: '200px 0px',
    triggerOnce: true,
  });
  const { data, error, isLoading, mutate } = useSWR<ProviderTitlesResponse>(
    inView ? ([row.endpoint, userId] as const) : null,
    ([endpoint]) =>
      axios
        .get<ProviderTitlesResponse>(endpoint)
        .then((response) => response.data),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      errorRetryCount: 0,
      keepPreviousData: false,
    }
  );
  const failure = error ? getDiscoveryFeedFailure(error) : undefined;
  const retryAfterSeconds =
    failure?.kind === 'rate-limited'
      ? (failure.retryAfterSeconds ?? 60)
      : undefined;
  const [retryDeadline, setRetryDeadline] = useState<number>();
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (retryAfterSeconds === undefined) {
      setRetryDeadline(undefined);
      return;
    }

    const deadline = Date.now() + retryAfterSeconds * 1000;
    setRetryDeadline(deadline);
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const currentTime = Date.now();
      setNow(currentTime);
      if (currentTime >= deadline) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [error, retryAfterSeconds]);

  const retryRemaining =
    retryAfterSeconds === undefined
      ? 0
      : retryDeadline === undefined
        ? retryAfterSeconds
        : Math.max(0, Math.ceil((retryDeadline - now) / 1000));

  if (inView && !isLoading && !error && !data?.items.length) return null;

  const errorMessage =
    failure?.kind === 'rate-limited'
      ? discoveryMessages['personalized.rateLimited']
      : failure?.kind === 'reconnect'
        ? discoveryMessages['personalized.reconnectRequired']
        : discoveryMessages['personalized.rowFailed'];

  return (
    <section
      ref={ref}
      className="mb-8"
      aria-label={intl.formatMessage(row.title)}
      data-testid={`personal-discovery-row-${row.id}`}
    >
      <h2 className="mb-2 text-xl font-semibold text-white">
        <FormattedMessage {...row.title} />
      </h2>
      {error && failure && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-yellow-600 bg-yellow-900/30 p-3 text-sm"
        >
          <span>
            <FormattedMessage
              {...errorMessage}
              values={{
                provider: providerNames[row.provider],
                seconds: retryRemaining,
              }}
            />
          </span>
          {failure.kind === 'reconnect' ? (
            <Link
              href="/profile/settings/linked-accounts"
              className="text-blue-300 underline"
            >
              <FormattedMessage {...discoveryMessages['personalized.manage']} />
            </Link>
          ) : (
            <Button
              buttonSize="sm"
              disabled={isLoading || retryRemaining > 0}
              onClick={() => void mutate()}
            >
              <FormattedMessage {...discoveryMessages['personalized.retry']} />
            </Button>
          )}
        </div>
      )}
      {inView && (
        <Slider
          sliderKey={row.id}
          items={data?.items.map((item) => (
            <ProviderTitleCard key={item.id} item={item} />
          ))}
          isLoading={isLoading}
        />
      )}
    </section>
  );
}

export default function PersonalizedRows() {
  const intl = useIntl();
  const { user } = useUser();
  const accountKey = user?.id ? ([`${base}/accounts`, user.id] as const) : null;
  const {
    data: connectionData,
    error,
    isLoading,
    mutate,
  } = useSWR<ProviderAccountsResponse>(
    accountKey,
    ([endpoint]) =>
      axios
        .get<ProviderAccountsResponse>(endpoint)
        .then((response) => response.data),
    {
      revalidateOnFocus: false,
      dedupingInterval: 60000,
      keepPreviousData: false,
    }
  );
  const connectedProviders = useMemo(
    () => new Set(connectionData?.accounts.map((account) => account.provider)),
    [connectionData?.accounts]
  );
  const visibleRows = rows.filter((row) =>
    connectedProviders.has(row.provider)
  );

  if (!user?.id || (!isLoading && !error && visibleRows.length === 0))
    return null;

  return (
    <section className="mb-8" aria-labelledby="personal-discovery-title">
      <h2
        id="personal-discovery-title"
        className="mb-4 text-2xl font-semibold text-white"
      >
        <FormattedMessage {...discoveryMessages['personalized.title']} />
      </h2>
      {error && !connectionData ? (
        <div
          role="alert"
          className="rounded-lg border border-yellow-600 bg-yellow-900/30 p-4 text-sm"
        >
          <p>
            <FormattedMessage {...discoveryMessages['personalized.failed']} />
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <Link
              href="/profile/settings/linked-accounts"
              className="text-blue-300 underline"
            >
              <FormattedMessage {...discoveryMessages['personalized.manage']} />
            </Link>
            <Button buttonSize="sm" onClick={() => void mutate()}>
              <FormattedMessage {...discoveryMessages['personalized.retry']} />
            </Button>
          </div>
        </div>
      ) : isLoading && !connectionData ? (
        <p role="status" className="text-sm text-gray-400">
          {intl.formatMessage(discoveryMessages['providers.loading'])}
        </p>
      ) : (
        visibleRows.map((row) => (
          <PersonalizedRow key={row.id} row={row} userId={user.id} />
        ))
      )}
    </section>
  );
}
