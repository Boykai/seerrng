import CreateIssueModal from '@app/components/IssueModal/CreateIssueModal';
import { Transition } from '@headlessui/react';

interface IssueModalProps {
  show?: boolean;
  onCancel: () => void;
  mediaType: 'movie' | 'tv' | 'music' | 'book' | 'comic' | 'magazine' | 'manga';
  tmdbId?: number;
  mediaId?: number;
  title?: string;
  backdrop?: string;
  issueId?: never;
}

const IssueModal = ({
  show,
  mediaType,
  onCancel,
  tmdbId,
  mediaId,
  title,
  backdrop,
}: IssueModalProps) => (
  <Transition
    as="div"

    show={show}
  >
    <CreateIssueModal
      mediaType={mediaType}
      onCancel={onCancel}
      mediaId={mediaId}
      tmdbId={tmdbId}
      title={title}
      backdrop={backdrop}
    />
  </Transition>
);

export default IssueModal;
