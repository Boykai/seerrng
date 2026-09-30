import VisualLab from '@app/components/VisualLab';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const VisualLabPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);

  return <VisualLab />;
};

export default VisualLabPage;
