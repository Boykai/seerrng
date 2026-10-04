import Alert from '@app/components/Common/Alert';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import {
  FilterResetButton,
  getFilterToggleButtonClass,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import { PinnedFilterSectionGroup } from '@app/components/Discover/PinnedFilterSection';
import MediaSlider from '@app/components/MediaSlider';
import useDebouncedState from '@app/hooks/useDebouncedState';
import useDiscover from '@app/hooks/useDiscover';
import useDiscoverScrollRestoration from '@app/hooks/useDiscoverScrollRestoration';
import { useSearchActivityReporter } from '@app/hooks/useSearchActivity';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  BarsArrowUpIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/solid';
import type { MangaResult } from '@server/models/Manga';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import MangaFilters from './MangaFilters';
import {
  clearedMangaFilters,
  getMangaFilterParams,
  type MangaFilterUpdate,
} from './mangaFilterParams';

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
  startDate: 'Start Date',
  title: 'Title',
  trendingManga: 'Trending Manga',
  popularManga: 'Popular Manga',
  topRatedManga: 'Top Rated Manga',
  unavailable: 'Manga discovery is unavailable right now.',
});

// Each sort starts descending; selecting the active descending sort again
// reverses it. Trending has one direction.
const MANGA_SORTS = [
  { label: 'trending', desc: 'trending' },
  { label: 'popular', desc: 'popular', asc: 'popular.asc' },
  { label: 'topRated', desc: 'top_rated', asc: 'top_rated.asc' },
  { label: 'startDate', desc: 'start_date.desc', asc: 'start_date.asc' },
  { label: 'title', desc: 'title.desc', asc: 'title.asc' },
] as const satisfies readonly {
  label: keyof typeof messages;
  desc: string;
  asc?: string;
}[];
const MANGA_SHELVES = [
  { sort: 'trending', title: 'trendingManga' },
  { sort: 'popular', title: 'popularManga' },
  { sort: 'top_rated', title: 'topRatedManga' },
] as const satisfies readonly { sort: string; title: keyof typeof messages }[];

const getMangaSort = (value: unknown): string | undefined =>
  MANGA_SORTS.flatMap((sort) =>
    'asc' in sort ? [sort.desc, sort.asc] : [sort.desc]
  ).find((sort) => sort === value);

const DiscoverManga = () => {
  const intl = useIntl();
  const router = useRouter();
  const update = useBatchUpdateQueryParams({});
  const query =
    typeof router.query.query === 'string' ? router.query.query.trim() : '';
  const sortBy = getMangaSort(router.query.sortBy);
  const filters = getMangaFilterParams(router.query);
  const hasFilters = Object.keys(filters).length > 0;
  // Without a sort, keyword or filter the page shows one shelf per sort order.
  const showShelves = !sortBy && !query && !hasFilters;
  // Keyword results are ordered by relevance unless a sort is chosen.
  const activeSort = sortBy ?? (showShelves || query ? undefined : 'trending');
  const [search, debouncedSearch, setSearch] = useDebouncedState(query);
  const routedSearchRef = useRef(query);
  useEffect(() => {
    routedSearchRef.current = query;
    setSearch(query);
  }, [query, setSearch]);

  const discover = useDiscover<MangaResult>(
    '/api/v1/discover/manga',
    { query, sortBy, ...filters },
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
    search.trim() !== query ||
      (!showShelves &&
        (discover.isLoadingInitialData || discover.isValidating)),
    'manga-discovery'
  );
  const setParam = (values: MangaFilterUpdate & { sortBy?: string }) =>
    update({ ...values, page: undefined });
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
      <div className="app-filter-section-gap">
        <Header>{title}</Header>
        <PinnedFilterSectionGroup
          mediaType="manga"
          sections={[
            {
              section: 'filters',
              label: intl.formatMessage(messages.filters),
              children: (
                <div className="app-filter-row">
                  <FilterResetButton
                    label={intl.formatMessage(messages.clearFilters)}
                    selected={showShelves && !search.trim()}
                    onClick={() => {
                      routedSearchRef.current = '';
                      setSearch('');
                      update({
                        ...clearedMangaFilters,
                        query: undefined,
                        sortBy: undefined,
                        page: undefined,
                      });
                    }}
                  />
                  <form
                    className="discover-filter-control app-filter-search-control"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const nextSearch = search.trim();
                      routedSearchRef.current = nextSearch;
                      update({
                        query: nextSearch || undefined,
                        page: undefined,
                      });
                    }}
                  >
                    <span
                      className={`discover-filter-control-label ${
                        search.trim()
                          ? 'discover-filter-control-label-active'
                          : ''
                      }`}
                    >
                      <MagnifyingGlassIcon aria-hidden="true" />
                      {intl.formatMessage(messages.search)}
                    </span>
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder={intl.formatMessage(messages.searchManga)}
                      aria-label={intl.formatMessage(messages.searchManga)}
                      className="app-filter-search-input"
                    />
                  </form>
                  <MangaFilters filters={filters} onChange={setParam} />
                </div>
              ),
            },
            {
              section: 'sortBy',
              label: intl.formatMessage(messages.sortBy),
              children: (
                <div className="app-filter-row">
                  {MANGA_SORTS.map((option) => {
                    const ascending =
                      'asc' in option && activeSort === option.asc;
                    const active = ascending || activeSort === option.desc;
                    const Icon = ascending
                      ? BarsArrowUpIcon
                      : BarsArrowDownIcon;

                    return (
                      <button
                        key={option.desc}
                        type="button"
                        aria-pressed={active}
                        onClick={() =>
                          setParam({
                            sortBy:
                              active && !ascending && 'asc' in option
                                ? option.asc
                                : option.desc,
                          })
                        }
                        className={getFilterToggleButtonClass(active)}
                      >
                        {intl.formatMessage(messages[option.label])}
                        <Icon aria-hidden="true" />
                      </button>
                    );
                  })}
                </div>
              ),
            },
          ]}
        />
      </div>
      {showShelves ? (
        MANGA_SHELVES.map((shelf) => (
          <MediaSlider
            key={shelf.sort}
            sliderKey={`manga-${shelf.sort}`}
            title={intl.formatMessage(messages[shelf.title])}
            url="/api/v1/discover/manga"
            extraParams={`sortBy=${shelf.sort}`}
            linkUrl={`/discover/manga?sortBy=${shelf.sort}`}
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
