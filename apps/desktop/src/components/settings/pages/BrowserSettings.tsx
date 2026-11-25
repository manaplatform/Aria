import { WebBrowserSettings } from '../WebBrowserSettings';
import { SettingsPage } from '../SettingsPage';

export default function BrowserSettings() {
  return <SettingsPage title="Browser" description="Configure web access, browsing, site data, and permissions."><WebBrowserSettings /></SettingsPage>;
}
