import Button from '@app/components/Common/Button';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { getIndexerSearchHref } from '@app/utils/indexerSearch';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type { MediaCategoryKey } from '@server/constants/mediaCategories';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.IndexerSearchLink', {
  label: 'Search Prowlarr',
  help: 'Open a prefilled search. This does not grab or download a release.',
});

const IndexerSearchLink = ({
  category,
  title,
}: {
  category: MediaCategoryKey;
  title: string;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const href = getIndexerSearchHref(category, title);

  if (!href || !hasPermission(Permission.MANAGE_REQUESTS)) return null;

  return (
    <Button
      as="a"
      href={href}
      buttonType="ghost"
      buttonSize="sm"
      title={intl.formatMessage(messages.help)}
    >
      <MagnifyingGlassIcon aria-hidden="true" />
      <span>{intl.formatMessage(messages.label)}</span>
    </Button>
  );
};

export default IndexerSearchLink;
