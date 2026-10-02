import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import {
  authModeMessages,
  messages,
  sharedMessages,
} from '@app/components/Settings/Suwayomi/messages';
import {
  authModeBadgeType,
  describeSuwayomiError,
  isSettingsAuthMode,
  readSuwayomiError,
} from '@app/components/Settings/Suwayomi/suwayomiForm';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import { getSafeHref } from '@app/utils/safeUrl';
import { Transition } from '@headlessui/react';
import {
  ChatBubbleBottomCenterTextIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from '@heroicons/react/24/solid';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import { buildServiceUrl } from '@server/utils/serviceUrl';
import axios from 'axios';
import dynamic from 'next/dynamic';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const SuwayomiModal = dynamic(
  () => import('@app/components/Settings/Suwayomi/SuwayomiModal')
);

const SuwayomiInstance = ({
  suwayomi,
  onEdit,
  onDelete,
}: {
  suwayomi: SuwayomiSettingsView;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const intl = useIntl();
  const address = buildServiceUrl({
    useSsl: suwayomi.useSsl,
    hostname: suwayomi.hostname,
    port: suwayomi.port,
    urlBase: suwayomi.baseUrl,
  });
  const href = getSafeHref(address);

  return (
    <li className="settings-service-card app-card-inset refreshed-inset-surface">
      <div className="settings-service-card-content">
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="settings-service-logo-link"
        >
          <ChatBubbleBottomCenterTextIcon className="h-10 w-10 flex-shrink-0 text-gray-300" />
        </a>
        <div className="settings-service-card-body">
          <h3 className="settings-service-title">
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="transition duration-300 hover:text-white hover:underline"
            >
              {suwayomi.name}
            </a>
          </h3>
          <div className="settings-service-badges">
            {isSettingsAuthMode(suwayomi.authMode) && (
              <Badge badgeType={authModeBadgeType[suwayomi.authMode]}>
                {intl.formatMessage(authModeMessages[suwayomi.authMode])}
              </Badge>
            )}
            {suwayomi.useSsl && (
              <Badge badgeType="success">
                {intl.formatMessage(sharedMessages.ssl)}
              </Badge>
            )}
          </div>
          <dl className="settings-service-details">
            <dt>{intl.formatMessage(sharedMessages.address)}</dt>
            <dd>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="transition duration-300 hover:text-white hover:underline"
              >
                {address}
              </a>
            </dd>
            <dt>{intl.formatMessage(messages.sources)}</dt>
            <dd>{intl.formatNumber(suwayomi.sourceAllowlist.length)}</dd>
          </dl>
          <div className="settings-card-actions settings-service-card-actions">
            <Button
              buttonType="warning"
              buttonSize="standard"
              onClick={() => onEdit()}
            >
              <PencilIcon />
              <span>{intl.formatMessage(globalMessages.edit)}</span>
            </Button>
            <Button
              buttonType="danger"
              buttonSize="standard"
              className="settings-service-delete-action"
              onClick={() => onDelete()}
            >
              <TrashIcon />
              <span>{intl.formatMessage(globalMessages.delete)}</span>
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
};

const SettingsSuwayomi = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<SuwayomiSettingsView[]>('/api/v1/settings/suwayomi');
  const [editModal, setEditModal] = useState<{
    open: boolean;
    suwayomi: SuwayomiSettingsView | null;
  }>({ open: false, suwayomi: null });
  const [deleteId, setDeleteId] = useState<number>();
  const [isDeleting, setIsDeleting] = useState(false);

  const refresh = () => {
    revalidate();
    mutate('/api/v1/settings/public');
  };

  const deleteServer = async () => {
    if (deleteId === undefined) return;
    setIsDeleting(true);
    try {
      await axios.delete(`/api/v1/settings/suwayomi/${deleteId}`);
      setDeleteId(undefined);
      refresh();
    } catch (e) {
      addToast(
        describeSuwayomiError(intl, readSuwayomiError(e), globalMessages.error),
        { appearance: 'error', autoDismiss: true }
      );
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <>
      <div className="mt-10 mb-6">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      {editModal.open && (
        <SuwayomiModal
          suwayomi={editModal.suwayomi}
          onClose={() => setEditModal({ open: false, suwayomi: null })}
          onSave={() => {
            refresh();
            setEditModal({ open: false, suwayomi: null });
          }}
        />
      )}
      <Transition
        as={Fragment}
        show={deleteId !== undefined}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(
            isDeleting ? globalMessages.deleting : globalMessages.delete
          )}
          okButtonType="danger"
          okButtonProps={{ buttonIcon: 'delete' }}
          okDisabled={isDeleting}
          onOk={() => deleteServer()}
          onCancel={() => setDeleteId(undefined)}
          title={intl.formatMessage(sharedMessages.deleteServer, {
            serverType: 'Suwayomi',
          })}
        >
          {intl.formatMessage(sharedMessages.deleteserverconfirm)}
        </Modal>
      </Transition>
      <div className="app-card-sub section settings-service-section">
        {error ? (
          <Alert
            type="error"
            title={intl.formatMessage(messages.loadFailure)}
          />
        ) : !data ? (
          <LoadingSpinner />
        ) : (
          <ul className="settings-service-grid">
            {data.map((suwayomi) => (
              <SuwayomiInstance
                key={`suwayomi-config-${suwayomi.id}`}
                suwayomi={suwayomi}
                onEdit={() => setEditModal({ open: true, suwayomi })}
                onDelete={() => setDeleteId(suwayomi.id)}
              />
            ))}
            {data.length === 0 && (
              <li className="col-span-1 h-32 rounded-lg border-2 border-dashed border-gray-400 shadow sm:h-44">
                <div className="flex h-full w-full items-center justify-center">
                  <Button
                    buttonType="success"
                    buttonSize="standard"
                    onClick={() => setEditModal({ open: true, suwayomi: null })}
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addServer)}</span>
                  </Button>
                </div>
              </li>
            )}
          </ul>
        )}
      </div>
    </>
  );
};

export default SettingsSuwayomi;
