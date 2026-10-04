import MangaSources from '@app/components/Settings/MangaSources';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsMangaSourcesPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <MangaSources />
    </SettingsLayout>
  );
};

export default SettingsMangaSourcesPage;
