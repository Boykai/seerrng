import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverTv from '@app/components/Discover/DiscoverTv';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import type { TvNetwork } from '@server/models/common';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const DiscoverTvNetwork = () => {
  const router = useRouter();
  const intl = useIntl();
  const title = intl.formatMessage(globalMessages.tvshows);
  const networkId =
    typeof router.query.networkId === 'string' ? router.query.networkId : '';
  const { data: network, error } = useSWR<TvNetwork>(
    networkId ? `/api/v1/network/${networkId}` : null
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

  if (!network) {
    return (
      <>
        <PageTitle title={title} />
        <Header>{title}</Header>
        <LoadingSpinner />
      </>
    );
  }

  return <DiscoverTv network={network} />;
};

export default DiscoverTvNetwork;
