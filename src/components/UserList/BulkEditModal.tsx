import Modal from '@app/components/Common/Modal';
import PermissionEdit from '@app/components/PermissionEdit';
import useToasts from '@app/hooks/useToasts';
import type { User } from '@app/hooks/useUser';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type {
  UserBulkUpdateRequest,
  UserBulkUpdateSettings,
} from '@server/interfaces/api/userInterfaces';
import { hasPermission } from '@server/lib/permissions';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

interface BulkEditProps {
  selectedUserIds: number[];
  users?: User[];
  onCancel?: () => void;
  onComplete?: (updatedUsers: User[]) => void;
  onSaving?: (isSaving: boolean) => void;
}

const messages = defineMessages('components.UserList', {
  userssaved: 'User updates saved successfully!',
  userfail: 'Something went wrong while saving user updates.',
  edituser: 'Bulk Edit Users',
  autoRequestSettings: 'Auto-Request Settings',
  autoRequestSettingsDescription:
    'Choose which automatic watchlist request settings to update. No Change keeps each selected user’s current value.',
  autoRequestMovies: 'Movies',
  autoRequestSeries: 'Series',
  autoRequestMusic: 'Music',
  autoRequestBooks: 'Books',
  autoRequestComics: 'Comics',
  autoRequestMagazines: 'Magazines',
  noChange: 'No Change',
  enabled: 'Enabled',
  disabled: 'Disabled',
});

const autoRequestFields = [
  ['watchlistSyncMovies', 'autoRequestMovies'],
  ['watchlistSyncTv', 'autoRequestSeries'],
  ['watchlistSyncMusic', 'autoRequestMusic'],
  ['watchlistSyncBooks', 'autoRequestBooks'],
  ['watchlistSyncComics', 'autoRequestComics'],
  ['watchlistSyncMagazines', 'autoRequestMagazines'],
] as const satisfies readonly [
  keyof UserBulkUpdateSettings,
  (
    | 'autoRequestMovies'
    | 'autoRequestSeries'
    | 'autoRequestMusic'
    | 'autoRequestBooks'
    | 'autoRequestComics'
    | 'autoRequestMagazines'
  ),
][];

const BulkEditModal = ({
  selectedUserIds,
  users,
  onCancel,
  onComplete,
  onSaving,
}: BulkEditProps) => {
  const { user: currentUser } = useUser();
  const intl = useIntl();
  const { addToast } = useToasts();
  const [currentPermission, setCurrentPermission] = useState(0);
  const [permissionChanged, setPermissionChanged] = useState(false);
  const [autoRequestSettings, setAutoRequestSettings] =
    useState<UserBulkUpdateSettings>({});
  const [isSaving, setIsSaving] = useState(false);

  const hasChanges =
    permissionChanged || Object.keys(autoRequestSettings).length > 0;

  useEffect(() => {
    if (onSaving) {
      onSaving(isSaving);
    }
  }, [isSaving, onSaving]);

  const updateUsers = async () => {
    try {
      setIsSaving(true);
      const update: UserBulkUpdateRequest = { ids: selectedUserIds };
      if (permissionChanged) {
        update.permissions = currentPermission;
      }
      if (Object.keys(autoRequestSettings).length > 0) {
        update.settings = autoRequestSettings;
      }

      const { data: updated } = await axios.put<User[]>(`/api/v1/user`, update);
      if (onComplete) {
        onComplete(updated);
      }
      addToast(intl.formatMessage(messages.userssaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.userfail), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  useEffect(() => {
    if (users) {
      const selectedUsers = users.filter((u) => selectedUserIds.includes(u.id));
      const { permissions: allPermissionsEqual } = selectedUsers.reduce(
        ({ permissions: aPerms }, { permissions: bPerms }) => {
          return {
            permissions:
              aPerms === bPerms || hasPermission(Permission.ADMIN, aPerms)
                ? aPerms
                : NaN,
          };
        },
        { permissions: selectedUsers[0].permissions }
      );
      if (allPermissionsEqual) {
        setCurrentPermission(allPermissionsEqual);
      }
      setPermissionChanged(false);
      setAutoRequestSettings({});
    }
  }, [users, selectedUserIds]);

  return (
    <Modal
      title={intl.formatMessage(messages.edituser)}
      onOk={() => {
        updateUsers();
      }}
      okDisabled={isSaving || !hasChanges}
      okText={intl.formatMessage(globalMessages.save)}
      onCancel={onCancel}
    >
      <div className="mb-6">
        <PermissionEdit
          actingUser={currentUser}
          currentPermission={currentPermission}
          onUpdate={(newPermission) => {
            setCurrentPermission(newPermission);
            setPermissionChanged(true);
          }}
        />
      </div>
      <div className="settings-page-content">
        <section className="settings-group-card">
          <h3 className="settings-group-heading">
            {intl.formatMessage(messages.autoRequestSettings)}
          </h3>
          <p className="settings-group-description">
            {intl.formatMessage(messages.autoRequestSettingsDescription)}
          </p>
          <div className="settings-group-content">
            {autoRequestFields.map(([fieldName, labelKey]) => (
              <div className="form-row" key={fieldName}>
                <label htmlFor={`bulk-${fieldName}`} className="text-label">
                  {intl.formatMessage(messages[labelKey])}
                </label>
                <div className="form-input-area">
                  <select
                    id={`bulk-${fieldName}`}
                    value={
                      autoRequestSettings[fieldName] === undefined
                        ? 'unchanged'
                        : autoRequestSettings[fieldName]
                          ? 'enabled'
                          : 'disabled'
                    }
                    onChange={(event) => {
                      const { value } = event.target;
                      setAutoRequestSettings((previous) => {
                        const next = { ...previous };
                        if (value === 'unchanged') {
                          delete next[fieldName];
                        } else {
                          next[fieldName] = value === 'enabled';
                        }
                        return next;
                      });
                    }}
                  >
                    <option value="unchanged">
                      {intl.formatMessage(messages.noChange)}
                    </option>
                    <option value="enabled">
                      {intl.formatMessage(messages.enabled)}
                    </option>
                    <option value="disabled">
                      {intl.formatMessage(messages.disabled)}
                    </option>
                  </select>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
};

export default BulkEditModal;
