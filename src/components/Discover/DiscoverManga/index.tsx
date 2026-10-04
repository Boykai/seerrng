import Alert from '@app/components/Common/Alert';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import {
  FilterResetButton,
  getFilterToggleButtonClass,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import MediaSlider from '@app/components/MediaSlider';
import useDebouncedState from '@app/hooks/useDebouncedState';
import useDiscover from '@app/hooks/useDiscover';
import useDiscoverScrollRestoration from '@app/hooks/useDiscoverScrollRestoration';
import { useSearchActivityReporter } from '@app/hooks/useSearchActivity';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
import type { MangaResult } from '@server/models/Manga';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverManga', {
  manga: 'Manga',
  filters: 'Filters',
  clearFilters: 'Clear Filters',
  search: 'Keyword Search',
  searchManga: 'Search Manga',
  sortBy: 'Sort By',
  trending: 'Trending',
  popular: 'Popular',
  topRated: 'Top Rated',
  trendingManga: 'Trending Manga',
  popularManga: 'Popular Manga',
  topRatedManga: 'Top Rated Manga',
  unavailable: 'Manga discovery is unavailable right now.',
});

const MANGA_SORTS = [
  { value: 'trending', label: 'trending', shelf: 'trendingManga' },
  { value: 'popular', label: 'popular', shelf: 'popularManga' },
  { value: 'top_rated', label: 'topRated', shelf: 'topRatedManga' },
] as const satisfies readonly {
  value: string;
  label: keyof typeof messages;
  shelf: keyof typeof messages;
}[];
type MangaSort = (typeof MANGA_SORTS)[number]['value'];

const getMangaSort = (value: unknown): MangaSort | undefined =>
  MANGA_SORTS.find((sort) => sort.value === value)?.value;

const DiscoverManga = () => {
  const intl = useIntl();
  const router = useRouter();
  const update = useBatchUpdateQueryParams({});
  const query =
    typeof router.query.query === 'string' ? router.query.query.trim() : '';
  const sortBy = getMangaSort(router.query.sortBy);
  // Without a sort or keyword the page shows one shelf per sort order.
  const showShelves = !sortBy && !query;
  const [search, debouncedSearch, setSearch] = useDebouncedState(query);
  const routedSearchRef = useRef(query);
  useEffect(() => {
    routedSearchRef.current = query;
    setSearch(query);
  }, [query, setSearch]);

  const discover = useDiscover<MangaResult>(
    '/api/v1/discover/manga',
    { query, sortBy },
    {
      enabled: !showShelves,
      showErrorToast: false,
      hideErrorWithResults: false,
    }
  );
  useDiscoverScrollRestoration({
    mediaType: 'manga',
    itemCount: discover.titles.length,
    shuffleSeed: discover.shuffleSeed,
    isLoading: discover.isLoadingInitialData || discover.isLoadingMore,
    isReachingEnd: discover.isReachingEnd,
    fetchMore: discover.fetchMore,
  });
  useSearchActivityReporter(
    Boolean(search.trim()) &&
      (search.trim() !== query ||
        discover.isLoadingInitialData ||
        discover.isValidating),
    'manga-keyword'
  );
  useEffect(() => {
    const nextSearch = debouncedSearch.trim();

    if (nextSearch !== routedSearchRef.current) {
      routedSearchRef.current = nextSearch;
      update({ query: nextSearch || undefined, page: undefined });
    }
  }, [debouncedSearch, update]);

  const title = intl.formatMessage(messages.manga);
  const providerMessage = (
    discover.error as { response?: { data?: { message?: string } } } | undefined
  )?.response?.data?.message;

  return (
    <>
      <PageTitle title={title} />
      <div className="mb-4">
        <Header>{title}</Header>
        <div className="app-filter-section-heading">
          {intl.formatMessage(messages.filters)}
        </div>
        <div className="flex flex-wrap gap-2">
          <FilterResetButton
            label={intl.formatMessage(messages.clearFilters)}
            selected={showShelves && !search.trim()}
            onClick={() => {
              routedSearchRef.current = '';
              setSearch('');
              update({ query: undefined, sortBy: undefined, page: undefined });
            }}
          />
          <form
            className="discover-filter-control w-72 max-w-full flex-none"
            onSubmit={(event) => {
              event.preventDefault();
              const nextSearch = search.trim();
              routedSearchRef.current = nextSearch;
              update({ query: nextSearch || undefined, page: undefined });
            }}
          >
            <span
              className={`discover-filter-control-label gap-1.5 ${
                search.trim() ? 'discover-filter-control-label-active' : ''
              }`}
            >
              <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
              {intl.formatMessage(messages.search)}
            </span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={intl.formatMessage(messages.searchManga)}
              aria-label={intl.formatMessage(messages.searchManga)}
              className="min-w-0 flex-1 border-0 bg-transparent px-2 py-0 text-xs font-medium text-gray-200 placeholder:text-gray-500 focus:ring-0"
            />
          </form>
        </div>
        <div className="app-filter-section-heading">
          {intl.formatMessage(messages.sortBy)}
        </div>
        <div className="flex flex-wrap gap-2">
          {MANGA_SORTS.map((sort) => (
            <button
              key={sort.value}
              type="button"
              aria-pressed={sortBy === sort.value}
              onClick={() => update({ sortBy: sort.value, page: undefined })}
              className={getFilterToggleButtonClass(sortBy === sort.value)}
            >
              {intl.formatMessage(messages[sort.label])}
              <BarsArrowDownIcon className="h-4 w-4" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
      {showShelves ? (
        MANGA_SORTS.map((sort) => (
          <MediaSlider
            key={sort.value}
            sliderKey={`manga-${sort.value}`}
            title={intl.formatMessage(messages[sort.shelf])}
            url="/api/v1/discover/manga"
            extraParams={`sortBy=${sort.value}`}
            linkUrl={`/discover/manga?sortBy=${sort.value}`}
          />
        ))
      ) : (
        <>
          {discover.error && (
            <Alert
              title={
                providerMessage ?? intl.formatMessage(messages.unavailable)
              }
              type="warning"
            />
          )}
          {(!discover.error || discover.titles.length > 0) && (
            <ListView
              items={discover.titles}
              isEmpty={discover.isEmpty}
              isLoading={
                discover.isLoadingInitialData ||
                (discover.isLoadingMore && discover.titles.length > 0)
              }
              isReachingEnd={discover.isReachingEnd}
              onScrollBottom={discover.fetchMore}
            />
          )}
        </>
      )}
    </>
  );
};

export default DiscoverManga;
