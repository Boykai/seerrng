import MangaLibrary from '@app/components/Settings/MangaLibrary';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const SettingsMangaLibraryPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <MangaLibrary />
    </SettingsLayout>
  );
};

export default SettingsMangaLibraryPage;
