import { getServerSideProps } from '@app/pages/issues/[issueId]';
import type { GetServerSidePropsContext } from 'next';
import { expect, it } from 'vitest';
import { getIssueListHref } from './issueNavigation';

it('links to inline issue details with strictly valid IDs', () => {
  expect(getIssueListHref(6)).toBe('/issues?issue=6');
  expect(getIssueListHref('12')).toBe('/issues?issue=12');
  for (const value of [
    undefined,
    '0',
    '-1',
    '1.5',
    'https://example.com',
    ['6'],
    '9007199254740992',
  ]) {
    expect(getIssueListHref(value)).toBe('/issues');
  }
});
it('redirects old issue URLs without rendering the removed page', async () => {
  const result = await getServerSideProps({
    params: { issueId: '6' },
  } as unknown as GetServerSidePropsContext);
  expect(result).toEqual({
    redirect: { destination: '/issues?issue=6', permanent: false },
  });
});
