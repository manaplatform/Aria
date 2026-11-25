import { useEffect, useState } from 'react';
import type { AboutInfo } from '@aria/shared';
import { desktop, errorMessage, openExternal } from '../../../services/desktop';
import { Button, Modal } from '../../ui';
import { UpdateSettings } from '../UpdateSettings';
import { SettingsPage } from '../SettingsPage';
import { SettingsSection } from '../components';

export default function AboutSettings() {
  const [info, setInfo] = useState<AboutInfo>();
  const [viewer, setViewer] = useState<'license' | 'notices' | 'inventory'>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (window.aria?.aboutInfo) void desktop().aboutInfo().then(setInfo).catch((failure) => setError(errorMessage(failure)));
  }, []);
  const text = viewer === 'license' ? info?.mitLicense : viewer === 'notices' ? info?.thirdPartyNotices : info?.thirdPartyInventory.map((item) => `${item.name} ${item.version} · ${item.license ?? 'License unavailable'}`).join('\n');
  return <SettingsPage title="About Aria" description="Version, updates, and open-source notices.">
    {info && <SettingsSection title="Aria Desktop"><p>Version {info.version} · {info.platform} {info.arch} · Electron {info.electronVersion}</p><div className="row"><Button size="sm" variant="secondary" onClick={() => void openExternal(info.repositoryUrl).catch((failure) => setError(errorMessage(failure)))}>Repository</Button><Button size="sm" variant="secondary" onClick={() => void openExternal(info.releaseNotesUrl).catch((failure) => setError(errorMessage(failure)))}>Release notes</Button></div></SettingsSection>}
    <UpdateSettings />
    <SettingsSection title="Licenses"><div className="row"><Button size="sm" variant="secondary" onClick={() => setViewer('license')}>MIT License</Button><Button size="sm" variant="secondary" onClick={() => setViewer('notices')}>Third-party notices</Button><Button size="sm" variant="secondary" onClick={() => setViewer('inventory')}>Package inventory</Button></div></SettingsSection>
    {error && <p role="alert">{error}</p>}
    <Modal open={Boolean(viewer)} onOpenChange={(open) => { if (!open) setViewer(undefined); }} title={viewer === 'license' ? 'MIT License' : viewer === 'notices' ? 'Third-party notices' : 'Package inventory'} description="Bundled license information"><pre style={{ whiteSpace: 'pre-wrap', maxHeight: '60vh', overflow: 'auto' }}>{text || 'This information is unavailable in this build.'}</pre></Modal>
  </SettingsPage>;
}
