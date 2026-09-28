import DiscoveryConfiguration from '@app/components/DiscoveryIntegrations/Configuration';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
export default function DiscoverySettingsPage() {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <DiscoveryConfiguration />
    </SettingsLayout>
  );
}
