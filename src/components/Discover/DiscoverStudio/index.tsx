import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverMovies from '@app/components/Discover/DiscoverMovies';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import type { ProductionCompany } from '@server/models/common';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const DiscoverMovieStudio = () => {
  const router = useRouter();
  const intl = useIntl();
  const title = intl.formatMessage(globalMessages.movies);
  const studioId =
    typeof router.query.studioId === 'string' ? router.query.studioId : '';
  const { data: studio, error } = useSWR<ProductionCompany>(
    studioId ? `/api/v1/studio/${studioId}` : null
  );

  if (error) {
    return (
      <>
        <PageTitle title={title} />
        <Header>{title}</Header>
        <ErrorPage statusCode={500} />
      </>
    );
  }

  if (!studio) {
    return (
      <>
        <PageTitle title={title} />
        <Header>{title}</Header>
        <LoadingSpinner />
      </>
    );
  }

  return <DiscoverMovies studio={studio} />;
};

export default DiscoverMovieStudio;
