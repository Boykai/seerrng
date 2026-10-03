import {
  isAnilistId,
  isInstanceId,
} from '@app/components/Settings/MangaSources/requestBodies';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { LinkIcon } from '@heroicons/react/24/outline';
import Link from 'next/link';
import { useIntl } from 'react-intl';

// The page's id and text again, so request screens load only this string.
const messages = defineMessages('components.Settings.MangaSources', {
  chooseSource: 'Choose Source',
});

/** The Manga Sources page with one title's detail open. */
export const getMangaSourcesHref = (
  anilistId?: number | null,
  instanceId?: number | null
): string | undefined =>
  isAnilistId(anilistId) && isInstanceId(instanceId)
    ? `/settings/manga-sources?anilistId=${anilistId}&instanceId=${instanceId}`
    : undefined;

interface ChooseSourceLinkProps {
  anilistId?: number | null;
  /** The request's Suwayomi instance; the first instance has ID 0. */
  instanceId?: number | null;
  /** A small button for an action row instead of a text link. */
  asButton?: boolean;
}

/** Takes an administrator to the source picker for a parked title. */
const ChooseSourceLink = ({
  anilistId,
  instanceId,
  asButton = false,
}: ChooseSourceLinkProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const href = getMangaSourcesHref(anilistId, instanceId);

  if (!href || !hasPermission(Permission.ADMIN)) {
    return null;
  }

  const label = intl.formatMessage(messages.chooseSource);

  return asButton ? (
    <Link href={href} className="app-button app-button-manage button-sm">
      <LinkIcon aria-hidden="true" />
      {label}
    </Link>
  ) : (
    <>
      {' '}
      <Link href={href} className="request-manga-source-link">
        {label}
      </Link>
    </>
  );
};

export default ChooseSourceLink;
