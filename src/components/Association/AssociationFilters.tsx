import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import FilterPanel from '@app/components/Discover/FilterPanel';
import {
  CompactSelect,
  FilterResetButton,
} from '@app/components/Discover/FilterPanel/CompactFilterSelect';
import PinnedFilterSection from '@app/components/Discover/PinnedFilterSection';
import type { FilterOptions } from '@app/components/Discover/constants';
import type {
  AssociationEdge,
  AssociationMediaType,
} from '@app/hooks/useAssociations';
import { mapWithConcurrency } from '@app/utils/concurrency';
import defineMessages from '@app/utils/defineMessages';
import { filterAndSortRelatedMedia } from '@app/utils/relatedMediaFilters';
import { MediaStatus } from '@server/constants/media';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Association.Filters', {
  filters: 'Filters',
  clear: 'Clear Filters',
  media: 'Media Type',
  association: 'Association',
  year: 'Release Year',
  availability: 'Availability',
  any: 'Any',
  available: 'Available',
  notRequested: 'Not Requested',
  movie: 'Movie',
  tv: 'Series',
  album: 'Album',
  artist: 'Artist',
  book: 'Book',
  person: 'Person',
  similar: 'Similar',
  recommended: 'Recommended',
  sharedPerson: 'Connected',
  sharedGenre: 'Shared Genre',
});

const getYear = (edge: AssociationEdge) => {
  const node = edge.node;
  const date =
    node.mediaType === 'movie'
      ? node.releaseDate
      : node.mediaType === 'tv'
        ? node.firstAirDate
        : node.mediaType === 'album'
          ? node['first-release-date']
          : node.mediaType === 'book'
            ? node.firstPublishYear?.toString()
            : undefined;
  return date?.slice(0, 4) ?? '';
};

const getAvailable = (edge: AssociationEdge): boolean | undefined => {
  const node = edge.node;
  const info = 'mediaInfo' in node ? node.mediaInfo : undefined;
  const statuses =
    node.mediaType === 'album'
      ? (node.qualityStatuses?.map((quality) => quality.status) ?? [])
      : [info?.status, info?.status4k];
  if (!info && statuses.length === 0) return undefined;
  return statuses.some(
    (status) =>
      status === MediaStatus.AVAILABLE ||
      status === MediaStatus.PARTIALLY_AVAILABLE
  );
};

type FilterProps = {
  edges: AssociationEdge[];
  mediaType: AssociationMediaType;
  children: (filtered: AssociationEdge[]) => ReactNode;
};

const isAvailable = (edge: AssociationEdge, quality: 'hd' | '4k') => {
  const info = 'mediaInfo' in edge.node ? edge.node.mediaInfo : undefined;
  const status = quality === '4k' ? info?.status4k : info?.status;
  return (
    status === MediaStatus.AVAILABLE ||
    status === MediaStatus.PARTIALLY_AVAILABLE
  );
};

function ScreenAssociationFilters({ edges, mediaType, children }: FilterProps) {
  const intl = useIntl();
  const [filters, setFilters] = useState<FilterOptions>({});
  const update = useCallback((values: Record<string, string | undefined>) => {
    setFilters((current) => {
      const next = { ...current, ...values } as Record<
        string,
        string | undefined
      >;
      Object.keys(next).forEach((key) => {
        if (next[key] === undefined) delete next[key];
      });
      return next as FilterOptions;
    });
  }, []);
  const needsDetails = Boolean(
    filters.studio ||
    filters.network ||
    filters.status ||
    filters.certification ||
    filters.withRuntimeGte ||
    filters.withRuntimeLte ||
    filters.watchProviders
  );
  const screenEdges = useMemo(
    () => edges.filter((edge) => edge.node.mediaType === mediaType),
    [edges, mediaType]
  );
  const ids = useMemo(
    () => [...new Set(screenEdges.map((edge) => Number(edge.node.id)))],
    [screenEdges]
  );
  const { data: details, isLoading } = useSWR<
    { id: number; data?: MovieDetails | TvDetails }[]
  >(
    needsDetails && ids.length
      ? ['association-filter-details', mediaType, ids.join(',')]
      : null,
    () =>
      mapWithConcurrency(ids, 3, async (id) => {
        try {
          const response = await axios.get<MovieDetails | TvDetails>(
            `/api/v1/${mediaType}/${id}`,
            { timeout: 20000 }
          );
          return { id, data: response.data };
        } catch {
          return { id };
        }
      }),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
  const detailById = new Map(details?.map(({ id, data }) => [id, data]));
  const matchesDetail = (edge: AssociationEdge) => {
    const detail = detailById.get(edge.node.id as number);
    if (!detail) return false;
    if (
      filters.studio &&
      !detail.productionCompanies.some(
        (company) => String(company.id) === filters.studio
      )
    )
      return false;
    if (
      filters.network &&
      !(
        'networks' in detail &&
        detail.networks.some(
          (network) => String(network.id) === filters.network
        )
      )
    )
      return false;
    if (filters.status && !filters.status.split('|').includes(detail.status))
      return false;
    if (filters.withRuntimeGte || filters.withRuntimeLte) {
      const runtime =
        'runtime' in detail
          ? detail.runtime
          : 'episodeRunTime' in detail
            ? detail.episodeRunTime[0]
            : undefined;
      if (
        runtime == null ||
        (filters.withRuntimeGte && runtime < Number(filters.withRuntimeGte)) ||
        (filters.withRuntimeLte && runtime > Number(filters.withRuntimeLte))
      )
        return false;
    }
    if (filters.certification) {
      const country = filters.certificationCountry ?? 'US';
      const certifications =
        'releases' in detail
          ? detail.releases.results
              .filter((release) => release.iso_3166_1 === country)
              .flatMap((release) =>
                release.release_dates.map((date) => date.certification)
              )
          : 'contentRatings' in detail
            ? detail.contentRatings.results
                .filter((rating) => rating.iso_3166_1 === country)
                .map((rating) => rating.rating)
            : [];
      if (!certifications.includes(filters.certification)) return false;
    }
    if (filters.watchProviders) {
      const providers = filters.watchProviders.split('|').map(Number);
      const region = filters.watchRegion ?? 'US';
      const available =
        detail.watchProviders?.find((entry) => entry.iso_3166_1 === region)
          ?.flatrate ?? [];
      if (!available.some((provider) => providers.includes(provider.id)))
        return false;
    }
    return true;
  };
  const filteredIds = new Set(
    filterAndSortRelatedMedia(
      screenEdges
        .map((edge) => edge.node)
        .filter(
          (node) => node.mediaType === 'movie' || node.mediaType === 'tv'
        ),
      filters
    ).map((node) => node.id)
  );
  const filtered = edges.filter((edge) => {
    if (edge.node.mediaType !== mediaType) return !Object.keys(filters).length;
    if (!filteredIds.has(Number(edge.node.id))) return false;
    if (filters.availability && !isAvailable(edge, filters.availability))
      return false;
    return !needsDetails || matchesDetail(edge);
  });
  return (
    <>
      <PinnedFilterSection
        mediaType={mediaType as 'movie' | 'tv'}
        section="filters"
        label={intl.formatMessage(messages.filters)}
      >
        <FilterPanel
          type={mediaType as 'movie' | 'tv'}
          currentFilters={filters}
          onFiltersChange={update}
        />
      </PinnedFilterSection>
      {needsDetails && isLoading ? <LoadingSpinner /> : children(filtered)}
    </>
  );
}

function OtherAssociationFilters({ edges, mediaType, children }: FilterProps) {
  const intl = useIntl();
  const [selectedMedia, setSelectedMedia] = useState('');
  const [selectedAssociation, setSelectedAssociation] = useState('');
  const [selectedYear, setSelectedYear] = useState('');
  const [selectedAvailability, setSelectedAvailability] = useState('');
  const mediaOptions = useMemo(
    () => [...new Set(edges.map((edge) => edge.node.mediaType))],
    [edges]
  );
  const associationOptions = useMemo(
    () => [...new Set(edges.map((edge) => edge.type))],
    [edges]
  );
  const yearOptions = useMemo(
    () =>
      [...new Set(edges.map(getYear).filter(Boolean))].sort((a, b) =>
        b.localeCompare(a)
      ),
    [edges]
  );
  const hasAvailability = edges.some(
    (edge) => getAvailable(edge) !== undefined
  );
  const filtered = edges.filter((edge) => {
    if (selectedMedia && edge.node.mediaType !== selectedMedia) return false;
    if (selectedAssociation && edge.type !== selectedAssociation) return false;
    if (selectedYear && getYear(edge) !== selectedYear) return false;
    if (selectedAvailability) {
      const available = getAvailable(edge);
      if (
        available === undefined ||
        available !== (selectedAvailability === 'available')
      )
        return false;
    }
    return true;
  });
  const pinType =
    mediaType === 'album' || mediaType === 'artist' ? 'music' : mediaType;

  return (
    <>
      <PinnedFilterSection
        mediaType={pinType}
        section="filters"
        label={intl.formatMessage(messages.filters)}
      >
        <div className="flex flex-wrap gap-2">
          <FilterResetButton
            label={intl.formatMessage(messages.clear)}
            selected={
              !selectedMedia &&
              !selectedAssociation &&
              !selectedYear &&
              !selectedAvailability
            }
            onClick={() => {
              setSelectedMedia('');
              setSelectedAssociation('');
              setSelectedYear('');
              setSelectedAvailability('');
            }}
          />
          <CompactSelect
            label={intl.formatMessage(messages.media)}
            value={selectedMedia}
            options={[
              { value: '', label: intl.formatMessage(messages.any) },
              ...mediaOptions.map((value) => ({
                value,
                label: intl.formatMessage(messages[value]),
              })),
            ]}
            onChange={setSelectedMedia}
          />
          <CompactSelect
            label={intl.formatMessage(messages.association)}
            value={selectedAssociation}
            options={[
              { value: '', label: intl.formatMessage(messages.any) },
              ...associationOptions.map((value) => ({
                value,
                label: intl.formatMessage(
                  value === 'shared-person'
                    ? messages.sharedPerson
                    : value === 'shared-genre'
                      ? messages.sharedGenre
                      : messages[value]
                ),
              })),
            ]}
            onChange={setSelectedAssociation}
          />
          {yearOptions.length > 0 && (
            <CompactSelect
              label={intl.formatMessage(messages.year)}
              value={selectedYear}
              options={[
                { value: '', label: intl.formatMessage(messages.any) },
                ...yearOptions.map((value) => ({ value, label: value })),
              ]}
              onChange={setSelectedYear}
            />
          )}
          {hasAvailability && (
            <CompactSelect
              label={intl.formatMessage(messages.availability)}
              value={selectedAvailability}
              options={[
                { value: '', label: intl.formatMessage(messages.any) },
                {
                  value: 'available',
                  label: intl.formatMessage(messages.available),
                },
                {
                  value: 'notRequested',
                  label: intl.formatMessage(messages.notRequested),
                },
              ]}
              onChange={setSelectedAvailability}
            />
          )}
        </div>
      </PinnedFilterSection>
      {children(filtered)}
    </>
  );
}

export default function AssociationFilters(props: FilterProps) {
  return props.mediaType === 'movie' || props.mediaType === 'tv' ? (
    <ScreenAssociationFilters {...props} />
  ) : (
    <OtherAssociationFilters {...props} />
  );
}
