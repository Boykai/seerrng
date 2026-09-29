import BookshelfPathMigration from '@app/components/Settings/BookshelfPathMigration';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const LibraryMigrationSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <BookshelfPathMigration />
    </SettingsLayout>
  );
};

export default LibraryMigrationSettingsPage;
