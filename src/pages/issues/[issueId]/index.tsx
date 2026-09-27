import { getIssueListHref } from '@app/utils/issueNavigation';
import type { GetServerSideProps, NextPage } from 'next';

// Compatibility only: previously sent notification links must still work.
const IssuePage: NextPage = () => null;

export const getServerSideProps: GetServerSideProps = async ({ params }) => ({
  redirect: {
    destination: getIssueListHref(params?.issueId),
    permanent: false,
  },
});

export default IssuePage;
