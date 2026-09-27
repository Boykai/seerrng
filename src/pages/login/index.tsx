import Login, { type LoginBackdrop } from '@app/components/Login';
import {
  getInternalApiBaseUrl,
  INTERNAL_API_HTTP_OPTIONS,
} from '@app/utils/internalApi';
import axios from 'axios';
import type { GetServerSideProps, NextPage } from 'next';

type LoginPageProps = {
  initialBackdrops?: LoginBackdrop[];
};

const LoginPage: NextPage<LoginPageProps> = ({ initialBackdrops }) => {
  return <Login initialBackdrops={initialBackdrops} />;
};

export const getServerSideProps: GetServerSideProps<
  LoginPageProps
> = async () => {
  try {
    const response = await axios.get<LoginBackdrop[]>(
      `${getInternalApiBaseUrl()}/api/v1/backdrops`,
      INTERNAL_API_HTTP_OPTIONS
    );

    return { props: { initialBackdrops: response.data } };
  } catch {
    return { props: {} };
  }
};

export default LoginPage;
