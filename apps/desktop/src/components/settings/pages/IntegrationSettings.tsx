import { ToolSettings } from '../ToolSettings';
import { SettingsPage } from '../SettingsPage';

export default function IntegrationSettings() {
  return <SettingsPage title="Tools & Integrations" description="Manage available tools and approved skills."><ToolSettings includeRuntime={false} /></SettingsPage>;
}
