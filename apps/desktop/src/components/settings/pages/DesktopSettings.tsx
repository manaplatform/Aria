import { RuntimeSettings } from '../RuntimeSettings';
import { SettingsPage } from '../SettingsPage';

export default function DesktopSettings() {
  return <SettingsPage title="Desktop Control" description="Manage desktop access and isolated execution."><RuntimeSettings /></SettingsPage>;
}
