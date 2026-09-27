import Button from '@app/components/Common/Button';
import MediaServerIcon, {
  getMediaServerName,
} from '@app/components/Common/MediaServerIcon';
import Modal from '@app/components/Common/Modal';
import SelectionCircle from '@app/components/Common/SelectionCircle';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type {
  CollectionDestination,
  CollectionSyncStatus,
} from '@server/interfaces/api/collectionSync';
import type { CollectionKind } from '@server/models/CuratedCollection';
import axios from 'axios';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import {
  availableDestinationCount,
  availableDestinationIds,
  collectionAddState,
  collectionRemoveState,
} from './collectionActionState';

const messages = defineMessages('components.CollectionDetails.ServerActions', {
  add: 'Add Collection',
  remove: 'Remove Collection',
  checking: 'Checking {server} for this collection.',
  unavailable: 'Cannot check {server} right now. Retrying automatically.',
  exists:
    'This collection already exists in the matching {server} destinations.',
  empty:
    'No items in this collection are available on {server} to add to this collection.',
  absent: 'This collection does not exist on {server}.',
  conflict:
    'An ambiguous or smart collection exists on {server}. Review it there before continuing.',
  help: 'Create this collection from available items currently shown on {server}. Newly available titles are added automatically afterward.',
  removeHelp:
    'Remove this collection from {server} and stop its automatic updates. Media files are not deleted.',
  confirm: 'Add collection to {server}?',
  confirmRemove: 'Remove collection from {server}?',
  description:
    'Only currently shown collection items already indexed in the selected libraries will be included now. Newly available titles will still be added automatically afterward. Existing collections are preserved.',
  removeDescription:
    'Remove the selected collection entries and their membership lists from {server}. This stops their automatic updates from Seerr. Library entries and media files remain untouched. Collections created outside Seerr are also removed if selected. You can choose a new selection and create the collection again with Add Collection.',
  cancel: 'Cancel',
  success: 'Collection added to {server}.',
  removed: 'Collection removed from {server}. Media files were not deleted.',
  failed:
    'Some collections could not be verified. Retrying automatically; do not assume the operation completed.',
});

const collectionServerEndpoint = (id: string, kind: CollectionKind): string => {
  const pattern =
    kind === 'music' ? /^[A-Za-z0-9_-]{1,128}$/ : /^[1-9]\d{0,8}$/;
  const safeId = id.match(pattern)?.[0];
  if (!safeId || safeId !== id) {
    throw new Error('Invalid collection identifier.');
  }

  if (kind === 'movie') return `/api/v1/collection/${safeId}/server`;
  if (kind === 'tv') return `/api/v1/collection-catalog/tv/${safeId}/server`;
  return `/api/v1/collection-catalog/music/${safeId}/server`;
};

const CollectionServerActions = ({
  id,
  title,
  availability,
  error,
  revalidate,
  visibleItemIds,
  kind = 'movie',
}: {
  id: string;
  title: string;
  availability?: { sync: CollectionSyncStatus };
  error?: unknown;
  revalidate: () => Promise<unknown>;
  selectedIds?: string[];
  visibleItemIds?: string[];
  kind?: CollectionKind;
}) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const { addToast } = useToasts();
  const server =
    getMediaServerName(currentSettings.mediaServerType) ?? 'media server';
  const [action, setAction] = useState<'add' | 'remove' | null>(null);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<CollectionDestination[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [availableItemIds, setAvailableItemIds] = useState<
    string[] | undefined
  >();
  const addState = collectionAddState(
    availability?.sync,
    error,
    visibleItemIds
  );
  const removeState = collectionRemoveState(availability?.sync, error);
  const state = action === 'remove' ? removeState : addState;
  const selectedChoices = choices.filter((entry) =>
    selected.includes(entry.libraryId)
  );
  if (!hasPermission(Permission.ADMIN)) return null;
  const open = (next: 'add' | 'remove') => {
    const options =
      availability?.sync.destinations.filter((entry) =>
        next === 'add'
          ? entry.state === 'missing' &&
            availableDestinationCount(entry, visibleItemIds) > 0
          : entry.state === 'exists' && !!entry.removalToken
      ) ?? [];
    // Freeze the verified identities shown in the confirmation; polling cannot retarget removal.
    setChoices(
      options.map((entry) => ({
        ...entry,
        count:
          next === 'add'
            ? availableDestinationCount(entry, visibleItemIds)
            : entry.count,
      }))
    );
    setSelected(options.map((entry) => entry.libraryId));
    setAvailableItemIds(
      next === 'add'
        ? availableDestinationIds(options, visibleItemIds)
        : undefined
    );
    setAction(next);
  };
  const perform = async () => {
    if (busy || !action || !selectedChoices.length) return;
    setBusy(true);
    try {
      const actionEndpoint = collectionServerEndpoint(id, kind);
      const result =
        action === 'remove'
          ? await axios.delete<CollectionSyncStatus>(actionEndpoint, {
              data: {
                destinations: selectedChoices.map(
                  ({ libraryId, removalToken }) => ({ libraryId, removalToken })
                ),
              },
              timeout: 60000,
            })
          : await axios.post<CollectionSyncStatus>(
              actionEndpoint,
              {
                libraryIds: selectedChoices.map((entry) => entry.libraryId),
                selectedIds: availableItemIds,
              },
              { timeout: 60000 }
            );
      const complete = selectedChoices.every((choice) =>
        result.data.destinations.some(
          (entry) =>
            entry.libraryId === choice.libraryId &&
            entry.state === (action === 'remove' ? 'missing' : 'exists')
        )
      );
      addToast(
        intl.formatMessage(
          complete
            ? action === 'remove'
              ? messages.removed
              : messages.success
            : messages.failed,
          { server }
        ),
        { appearance: complete ? 'success' : 'error', autoDismiss: true }
      );
      setAction(null);
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
      setAction(null);
    } finally {
      setBusy(false);
      void revalidate().catch(() => undefined);
    }
  };
  return (
    <>
      <div className="collection-server-actions">
        <Button
          buttonType="playback"
          disabled={busy || removeState !== 'ready'}
          title={intl.formatMessage(messages.removeHelp, { server })}
          disabledReason={intl.formatMessage(
            removeState === 'ready' ? messages.checking : messages[removeState],
            { server }
          )}
          onClick={() => open('remove')}
        >
          <MediaServerIcon
            mediaServerType={currentSettings.mediaServerType}
            className="playback-provider-icon"
          />
          <span>{intl.formatMessage(messages.remove)}</span>
        </Button>
        <Button
          buttonType="playback"
          disabled={busy || addState !== 'ready'}
          title={intl.formatMessage(messages.help, { server })}
          disabledReason={intl.formatMessage(
            addState === 'ready' ? messages.checking : messages[addState],
            { server }
          )}
          onClick={() => open('add')}
        >
          <MediaServerIcon
            mediaServerType={currentSettings.mediaServerType}
            className="playback-provider-icon"
          />
          <span>{intl.formatMessage(messages.add)}</span>
        </Button>
      </div>
      <Transition show={action !== null} as={Fragment}>
        <Modal
          title={intl.formatMessage(
            action === 'remove' ? messages.confirmRemove : messages.confirm,
            { server }
          )}
          onCancel={busy ? undefined : () => setAction(null)}
          onOk={() => void perform()}
          okText={intl.formatMessage(
            action === 'remove' ? messages.remove : messages.add
          )}
          cancelText={intl.formatMessage(messages.cancel)}
          okButtonType={action === 'remove' ? 'danger' : 'success'}
          cancelButtonType="success"
          cancelButtonProps={{ buttonIcon: 'cancel' }}
          okButtonProps={
            action === 'remove' ? { buttonIcon: 'delete' } : undefined
          }
          okDisabled={
            busy ||
            state !== 'ready' ||
            !selectedChoices.length ||
            (action === 'add' && !availableItemIds?.length)
          }
        >
          <div className="card-stack">
            <div className="app-card-inset refreshed-inset-surface detail-summary-card">
              {title}
            </div>
            <div className="app-card-inset refreshed-inset-surface detail-summary-card">
              {intl.formatMessage(
                action === 'remove'
                  ? messages.removeDescription
                  : messages.description,
                { server }
              )}
            </div>
            {choices.map((entry) => (
              <div
                className="app-card-inset refreshed-inset-surface detail-summary-card app-action-row"
                key={entry.libraryId}
              >
                <SelectionCircle
                  label={entry.libraryName}
                  selected={selected.includes(entry.libraryId)}
                  disabled={busy}
                  onClick={() =>
                    setSelected((current) =>
                      current.includes(entry.libraryId)
                        ? current.filter((value) => value !== entry.libraryId)
                        : [...current, entry.libraryId]
                    )
                  }
                />
                <span>
                  {entry.libraryName}
                  {action === 'add' ? ' — ' + entry.count : ''}
                </span>
              </div>
            ))}
          </div>
        </Modal>
      </Transition>
    </>
  );
};
export default CollectionServerActions;
