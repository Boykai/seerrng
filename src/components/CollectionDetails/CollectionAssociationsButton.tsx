import MeshNetworkIcon from '@app/assets/mesh-network.svg';
import AssociationFilters from '@app/components/Association/AssociationFilters';
import AssociationWall from '@app/components/Association/AssociationWall';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import Tooltip from '@app/components/Common/Tooltip';
import type {
  AssociationEdge,
  AssociationGraph,
} from '@app/hooks/useAssociations';
import { fetchCollectionAssociations } from '@app/utils/collectionAssociations';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.CollectionDetails.Associations', {
  associations: 'Associations',
  empty: 'No collection associations are available.',
});

const CollectionAssociationsButton = ({
  parts,
  mediaType = 'movie',
}: {
  parts: { id: string | number }[];
  mediaType?: 'movie' | 'tv' | 'album' | 'book';
}) => {
  const intl = useIntl();
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [edges, setEdges] = useState<AssociationEdge[]>([]);

  const open = async () => {
    setShow(true);
    if (edges.length > 0 || loading) return;
    setLoading(true);
    try {
      setEdges(await fetchCollectionAssociations(parts, mediaType));
    } finally {
      setLoading(false);
    }
  };
  const graph: AssociationGraph = {
    root: { mediaType, id: '', title: '' },
    edges,
  };

  return (
    <>
      <Tooltip content={intl.formatMessage(messages.associations)}>
        <Button
          buttonType="association"
          buttonSize="sm"
          onClick={() => void open()}
        >
          <MeshNetworkIcon />
          <span>{intl.formatMessage(messages.associations)}</span>
        </Button>
      </Tooltip>
      <Transition show={show} as="div">
        <Modal
          title={intl.formatMessage(messages.associations)}
          dialogClass="app-card-main request-modal-site-surface refreshed-detail-text !w-[calc(100%-2rem)] rounded-xl border border-gray-700 shadow-lg shadow-gray-950/20 sm:!max-w-4xl"
          onCancel={() => setShow(false)}
          cancelButtonType="danger"
          actionButtonSize="standard"
        >
          {loading ? (
            <LoadingSpinner />
          ) : edges.length === 0 ? (
            <p className="refreshed-detail-text text-center text-sm">
              {intl.formatMessage(messages.empty)}
            </p>
          ) : (
            <AssociationFilters edges={edges} mediaType={mediaType}>
              {(filtered) => (
                <AssociationWall
                  graph={{ ...graph, edges: filtered }}
                  onSelect={() => setShow(false)}
                />
              )}
            </AssociationFilters>
          )}
        </Modal>
      </Transition>
    </>
  );
};

export default CollectionAssociationsButton;
