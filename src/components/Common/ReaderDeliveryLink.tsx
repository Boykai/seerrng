import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { getSafeHref } from '@app/utils/safeUrl';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

type ReaderDeliveryTarget = 'ebooks' | 'audiobooks' | 'comics' | 'magazines';

interface ReaderDeliveryServiceResponse {
  provider: 'grimmory' | 'bookorbit';
  serviceName: string;
  serviceUrl: string | null;
  grimmoryUrl: string | null;
}

interface ReaderDeliveryLinkProps {
  target: ReaderDeliveryTarget;
}

const messages = defineMessages('components.ReaderDeliveryLink', {
  ebooks: 'Browse ebooks in {serviceName}',
  ebooksHelp:
    'Open the {serviceName} library in a browser. To browse in a reader app, copy its OPDS address under Settings > Services > Reader Apps and add it there.',
  audiobooks: 'Open Grimmory audiobook library',
  audiobooksHelp:
    'Open Grimmory, then choose an audiobook from its library player. Audiobook progress and playback are managed by Grimmory.',
  audiobooksBookOrbit: 'Open audiobooks in BookOrbit',
  audiobooksBookOrbitHelp:
    'Open BookOrbit and choose an audiobook from its built-in player. The web player supports M4B, MP3, M4A, OPUS, OGG, and FLAC. OPDS apps do not stream audiobook files.',
  comics: 'Browse comics in {serviceName}',
  comicsGrimmoryHelp:
    'Open the Grimmory library in a browser. For page-by-page comic reading, copy Grimmory’s Komga address under Settings > Services > Reader Apps into a compatible app.',
  comicsBookOrbitHelp:
    'Open the BookOrbit library and read CBZ, CBR, or CB7 files in its built-in comic reader. A compatible OPDS app can download CBZ or CBR archives; Grimmory Komga supports page-by-page streaming in comic apps.',
  magazines: 'Browse magazine PDFs in {serviceName}',
  magazinesHelp:
    'Open the {serviceName} library in a browser. Import magazine issues as PDF files there. Use Download issue for copies linked to your SeerrNG request.',
});

const normalizeReaderBaseUrl = (serviceUrl: string): string => {
  let normalized = serviceUrl.trim().replace(/\/+$/, '');
  for (const endpoint of ['/api/v1/opds', '/komga/api']) {
    if (normalized.endsWith(endpoint)) {
      normalized = normalized.slice(0, -endpoint.length);
      break;
    }
  }
  return normalized.replace(/\/+$/, '');
};

const ReaderDeliveryLink = ({ target }: ReaderDeliveryLinkProps) => {
  const intl = useIntl();
  const { data } = useSWR<ReaderDeliveryServiceResponse>(
    '/api/v1/service/reader-delivery'
  );

  const safeServiceUrl = getSafeHref(data?.serviceUrl);
  const safeGrimmoryUrl = getSafeHref(data?.grimmoryUrl);
  let href: string | undefined;
  let serviceName = data?.serviceName ?? 'Grimmory';
  if (target === 'audiobooks') {
    if (data?.provider === 'grimmory' && safeGrimmoryUrl) {
      href = normalizeReaderBaseUrl(safeGrimmoryUrl);
      serviceName = 'Grimmory';
    } else if (data?.provider === 'bookorbit' && safeServiceUrl) {
      href = normalizeReaderBaseUrl(safeServiceUrl);
      serviceName = 'BookOrbit';
    } else {
      return null;
    }
  } else if (
    target === 'comics' &&
    data?.provider === 'grimmory' &&
    safeGrimmoryUrl
  ) {
    href = normalizeReaderBaseUrl(safeGrimmoryUrl);
    serviceName = 'Grimmory';
  } else if (safeServiceUrl) {
    href = normalizeReaderBaseUrl(safeServiceUrl);
  }

  const safeHref = getSafeHref(href);
  if (!safeHref) return null;

  const labelMessage =
    target === 'ebooks'
      ? messages.ebooks
      : target === 'audiobooks'
        ? messages.audiobooks
        : target === 'comics'
          ? messages.comics
          : messages.magazines;
  const helpMessage =
    target === 'ebooks'
      ? messages.ebooksHelp
      : target === 'audiobooks'
        ? serviceName === 'Grimmory'
          ? messages.audiobooksHelp
          : messages.audiobooksBookOrbitHelp
        : target === 'comics'
          ? serviceName === 'Grimmory'
            ? messages.comicsGrimmoryHelp
            : messages.comicsBookOrbitHelp
          : messages.magazinesHelp;
  return (
    <Tooltip
      content={intl.formatMessage(helpMessage, {
        serviceName,
      })}
    >
      <Button
        as="a"
        href={safeHref}
        target="_blank"
        rel="noopener noreferrer"
        buttonType="externalService"
        buttonSize="sm"
      >
        {intl.formatMessage(
          target === 'audiobooks' && serviceName === 'BookOrbit'
            ? messages.audiobooksBookOrbit
            : labelMessage,
          { serviceName }
        )}
      </Button>
    </Tooltip>
  );
};

export default ReaderDeliveryLink;
