import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { MovieDetails } from '@server/models/Movie';
import dynamic from 'next/dynamic';

const ManageSlideOver = dynamic(
  () => import('@app/components/ManageSlideOver'),
  { ssr: false }
);

const request = {
  id: 29,
  type: MediaType.MOVIE,
  status: MediaRequestStatus.PENDING,
  requestedBy: { id: 2, displayName: 'callsta', avatar: '' },
  is4k: false,
  createdAt: new Date('2026-10-04T12:00:00.000Z'),
  seasons: [],
  media: undefined,
} as unknown as MediaRequest;

const movie = {
  id: 1234,
  title: 'The Social Reckoning',
  originalTitle: 'The Social Reckoning',
  adult: false,
  budget: 0,
  genres: [{ id: 18, name: 'Drama' }],
  originalLanguage: 'en',
  popularity: 0,
  productionCompanies: [{ id: 1, name: 'Columbia Pictures' }],
  productionCountries: [],
  releaseDate: '2026-10-07',
  releases: { results: [] },
  revenue: 0,
  spokenLanguages: [],
  status: 'Planned',
  video: false,
  voteAverage: 0,
  voteCount: 0,
  credits: {
    cast: [],
    crew: [
      { id: 1, name: 'Aaron Sorkin', job: 'Director' },
      { id: 2, name: 'Aaron Sorkin', job: 'Writer' },
    ],
  },
  externalIds: {},
  keywords: [],
  mediaInfo: {
    id: 42,
    mediaType: MediaType.MOVIE,
    tmdbId: 1234,
    status: MediaStatus.PENDING,
    status4k: MediaStatus.UNKNOWN,
    requests: [request],
    downloadStatus: [],
    downloadStatus4k: [],
    issues: [],
  },
} as unknown as MovieDetails;

const EditRequestQaPage = () => (
  <ManageSlideOver
    data={movie}
    mediaType="movie"
    onClose={() => undefined}
    revalidate={() => undefined}
    show
  />
);

export default EditRequestQaPage;

export const getServerSideProps = async () =>
  process.env.NODE_ENV === 'production' ? { notFound: true } : { props: {} };
