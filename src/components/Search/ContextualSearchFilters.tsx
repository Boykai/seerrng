import AvailabilityQualityControl, {
  type AvailabilityQuality,
} from '@app/components/Discover/AvailabilityQualityControl';
import FilterPanel from '@app/components/Discover/FilterPanel';
import LibraryFilterFields from '@app/components/Discover/FilterPanel/LibraryFilterFields';
import { prepareFilterValues } from '@app/components/Discover/constants';
import useDebouncedState from '@app/hooks/useDebouncedState';
import { useSearchActivityReporter } from '@app/hooks/useSearchActivity';
import { useBatchUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

import {
  getSearchResultFilter,
  type SearchFilterCategory,
} from './searchFilters';

const messages = defineMessages('components.Search.ContextualFilters', {
  keywordSearch: 'Keyword Search',
  searchAll: 'Search All Media',
  searchComics: 'Filter Comic Results',
  searchMagazines: 'Filter Magazine Results',
  searchAuthors: 'Search Authors',
});

const getQueryString = (value: string | string[] | undefined) =>
  typeof value === 'string' ? value : '';

const LibrarySearchFilters = ({
  category,
  filterQuery,
}: {
  category: Exclude<SearchFilterCategory, 'movie' | 'tv'>;
  filterQuery: string;
}) => {
  const intl = useIntl();
  const router = useRouter();
  const update = useBatchUpdateQueryParams({});
  const [search, debouncedSearch, setSearch] = useDebouncedState(filterQuery);
  const authorQuery = getQueryString(router.query.author);
  const [author, debouncedAuthor, setAuthor] = useDebouncedState(authorQuery);
  const routedAuthorRef = useRef(authorQuery.trim());
  const routedSearchRef = useRef(filterQuery.trim());

  useEffect(() => {
    const routedSearch = filterQuery.trim();
    if (routedSearch !== routedSearchRef.current) {
      routedSearchRef.current = routedSearch;
      setSearch(filterQuery);
    }
  }, [filterQuery, setSearch]);

  useEffect(() => {
    const nextSearch = debouncedSearch.trim();
    if (nextSearch !== routedSearchRef.current) {
      routedSearchRef.current = nextSearch;
      update(
        { resultFilter: nextSearch || undefined, page: undefined },
        { shallow: true, scroll: false }
      );
    }
  }, [debouncedSearch, update]);

  useEffect(() => {
    const routedAuthor = authorQuery.trim();
    if (routedAuthor !== routedAuthorRef.current) {
      routedAuthorRef.current = routedAuthor;
      setAuthor(authorQuery);
    }
  }, [authorQuery, setAuthor]);

  useEffect(() => {
    const nextAuthor = debouncedAuthor.trim();
    if (nextAuthor !== routedAuthorRef.current) {
      routedAuthorRef.current = nextAuthor;
      update(
        { author: nextAuthor || undefined, page: undefined },
        { shallow: true, scroll: false }
      );
    }
  }, [debouncedAuthor, update]);

  useSearchActivityReporter(
    (category === 'book' || category === 'audiobook') &&
      Boolean(author.trim()) &&
      author.trim() !== authorQuery.trim(),
    'main-search-author-input'
  );
  useSearchActivityReporter(
    Boolean(search.trim()) && search.trim() !== filterQuery.trim(),
    'main-search-keyword-input'
  );

  const setParam = (values: Record<string, string | undefined>) =>
    update({ ...values, page: undefined });
  const onSearchSubmit = () => {
    const nextSearch = search.trim();
    routedSearchRef.current = nextSearch;
    update(
      { resultFilter: nextSearch || undefined, page: undefined },
      { shallow: true, scroll: false }
    );
  };

  const renderKeywordSearch = (
    placeholder: (typeof messages)[
      'searchAll' | 'searchAuthors' | 'searchComics' | 'searchMagazines']
  ) => (
    <form
      className="discover-filter-control w-72 max-w-full flex-none"
      onSubmit={(event) => {
        event.preventDefault();
        onSearchSubmit();
      }}
    >
      <span
        className={
          'discover-filter-control-label' +
          (search.trim() ? ' discover-filter-control-label-active' : '')
        }
      >
        <MagnifyingGlassIcon className="h-4 w-4" aria-hidden="true" />
        {intl.formatMessage(messages.keywordSearch)}
      </span>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder={intl.formatMessage(placeholder)}
        aria-label={intl.formatMessage(placeholder)}
        className="min-w-0 flex-1 border-0 bg-transparent px-2 py-0 text-xs font-medium text-gray-200 placeholder:text-gray-500 focus:ring-0"
      />
    </form>
  );

  if (category === 'all') {
    return renderKeywordSearch(messages.searchAll);
  }

  if (category === 'book' || category === 'audiobook') {
    return (
      <LibraryFilterFields
        mediaType="book"
        audiobook={category === 'audiobook'}
        search={search}
        onSearchChange={setSearch}
        onSearchSubmit={onSearchSubmit}
        author={author}
        onAuthorChange={setAuthor}
        onAuthorSubmit={() => {
          const nextAuthor = author.trim();
          routedAuthorRef.current = nextAuthor;
          update(
            { author: nextAuthor || undefined, page: undefined },
            { shallow: true, scroll: false }
          );
        }}
        firstPublishYear={getQueryString(router.query.firstPublishYear)}
        subject={getQueryString(router.query.subject)}
        minRating={getQueryString(router.query.minRating)}
        language={getQueryString(router.query.language)}
        setParam={setParam}
      />
    );
  }

  if (category !== 'music') {
    return renderKeywordSearch(
      category === 'author'
        ? messages.searchAuthors
        : category === 'comic'
          ? messages.searchComics
          : messages.searchMagazines
    );
  }

  const releaseDateGte = getQueryString(router.query.primaryReleaseDateGte);
  const releaseDateLte = getQueryString(router.query.primaryReleaseDateLte);
  const releaseYear =
    !releaseDateGte && !releaseDateLte
      ? 'any'
      : !releaseDateGte && releaseDateLte === '1969-12-31'
        ? 'before-1970'
        : releaseDateGte.endsWith('-01-01') &&
            releaseDateLte === releaseDateGte.slice(0, 4) + '-12-31'
          ? releaseDateGte.slice(0, 4)
          : 'any';

  return (
    <LibraryFilterFields
      mediaType="music"
      search={search}
      onSearchChange={setSearch}
      onSearchSubmit={onSearchSubmit}
      genre={getQueryString(router.query.genre)}
      releaseType={getQueryString(router.query.releaseType)}
      releaseYear={releaseYear}
      setParam={setParam}
    />
  );
};

const ContextualSearchFilters = ({
  category,
}: {
  category: SearchFilterCategory;
}) => {
  const router = useRouter();
  const update = useBatchUpdateQueryParams({});
  const filterQuery = getSearchResultFilter(router.query);

  if (category === 'movie' || category === 'tv') {
    const currentFilters = prepareFilterValues({
      ...router.query,
      search: filterQuery || undefined,
    });

    return (
      <>
        <AvailabilityQualityControl
          mediaType={category}
          value={currentFilters.availability}
          onChange={(value) =>
            update({ availability: value || undefined, page: undefined })
          }
        />
        <FilterPanel
          type={category}
          currentFilters={currentFilters}
          variant="search"
          searchQueryKey="resultFilter"
        />
      </>
    );
  }

  const availability: AvailabilityQuality | undefined =
    category === 'music' &&
    (router.query.availability === 'mp3' ||
      router.query.availability === 'flac')
      ? router.query.availability
      : undefined;

  return (
    <>
      {category === 'music' && (
        <AvailabilityQualityControl
          mediaType="music"
          value={availability}
          onChange={(value) =>
            update({ availability: value || undefined, page: undefined })
          }
        />
      )}
      <LibrarySearchFilters category={category} filterQuery={filterQuery} />
    </>
  );
};

export default ContextualSearchFilters;
