import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import type { StatusResponse } from '@server/interfaces/api/settingsInterfaces';
import { useRouter } from 'next/router';
import { Fragment, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.StatusChecker', {
  appUpdated: '{applicationTitle} Updated',
  appUpdatedDescription:
    'Please click the button below to reload the application.',
  reloadApp: 'Reload {applicationTitle}',
  restartRequired: 'Server Restart Required',
  restartRequiredDescription:
    'Please restart the server to apply the updated settings.',
});

const StatusChecker = () => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const isAuthPage = /^\/(login|setup|resetpassword(?:\/|$))/.test(
    router.pathname
  );
  const [statusCheckEnabled, setStatusCheckEnabled] = useState(false);

  useEffect(() => {
    if (isAuthPage) {
      setStatusCheckEnabled(false);
      return;
    }

    if ('requestIdleCallback' in window) {
      const idleCallback = window.requestIdleCallback(
        () => setStatusCheckEnabled(true),
        { timeout: 10000 }
      );

      return () => window.cancelIdleCallback(idleCallback);
    }

    const timeout = globalThis.setTimeout(
      () => setStatusCheckEnabled(true),
      5000
    );

    return () => globalThis.clearTimeout(timeout);
  }, [isAuthPage]);

  const { data, error } = useSWR<StatusResponse>(
    statusCheckEnabled ? '/api/v1/status?checkUpdateAvailable=false' : null,
    {
      refreshInterval: 60 * 1000,
      revalidateOnFocus: false,
    }
  );
  const [alertDismissed, setAlertDismissed] = useState(false);
  const previousRestartRequired = useRef(data?.restartRequired);

  useEffect(() => {
    if (previousRestartRequired.current && !data?.restartRequired) {
      setAlertDismissed(false);
    }
    previousRestartRequired.current = data?.restartRequired;
  }, [data?.restartRequired]);

  if (!data && !error) {
    return null;
  }

  if (!data) {
    return null;
  }

  const clientCommitTag = process.env.commitTag;
  const hasBuildCommitMismatch =
    !!data.commitTag &&
    !!clientCommitTag &&
    data.commitTag !== 'local' &&
    data.commitTag !== clientCommitTag;

  return (
    <Transition
      as={Fragment}

      appear
      show={
        !alertDismissed &&
        ((hasPermission(Permission.ADMIN) && data.restartRequired) ||
          hasBuildCommitMismatch)
      }
    >
      {hasPermission(Permission.ADMIN) && data.restartRequired ? (
        <Modal
          title={intl.formatMessage(messages.restartRequired)}
          backgroundClickable={false}
          onOk={() => {
            setAlertDismissed(true);
            if (hasBuildCommitMismatch) {
              location.reload();
            }
          }}
          okText={intl.formatMessage(globalMessages.close)}
        >
          {intl.formatMessage(messages.restartRequiredDescription)}
        </Modal>
      ) : (
        <Modal
          title={intl.formatMessage(messages.appUpdated, {
            applicationTitle: settings.currentSettings.applicationTitle,
          })}
          onOk={() => location.reload()}
          okText={intl.formatMessage(messages.reloadApp, {
            applicationTitle: settings.currentSettings.applicationTitle,
          })}
          backgroundClickable={false}
        >
          {intl.formatMessage(messages.appUpdatedDescription)}
        </Modal>
      )}
    </Transition>
  );
};

export default StatusChecker;
