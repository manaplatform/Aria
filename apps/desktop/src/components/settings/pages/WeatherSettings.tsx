import { useEffect, useState } from 'react';
import type { WeatherSettings, WeatherSettingsView } from '@aria/shared';
import { SettingsPage } from '../SettingsPage';
import {
  SettingsGroup,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsToggle,
} from '../components';

export default function WeatherSettingsPage() {
  const [settings, setSettings] = useState<WeatherSettingsView>();
  const [location, setLocation] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!window.aria) {
      setError('Weather settings require the desktop application.');
      return;
    }
    void window.aria
      .weatherSettings()
      .then((value) => {
        setSettings(value);
        setLocation(typeof value.defaultLocation === 'string' ? value.defaultLocation : '');
      })
      .catch(() => setError('Weather settings could not be loaded.'));
  }, []);
  const save = async (change: Partial<WeatherSettings>) => {
    if (!settings || !window.aria) return;
    const current: WeatherSettings = {
      enabled: settings.enabled,
      provider: settings.provider,
      defaultLocation: settings.defaultLocation,
      temperature: settings.temperature,
      wind: settings.wind,
    };
    try {
      setSettings(await window.aria.saveWeatherSettings({ ...current, ...change }));
      setError('');
    } catch {
      setError('Weather settings could not be saved.');
    }
  };
  return (
    <SettingsPage
      title="Weather & Location"
      description="Choose weather preferences stored on this device."
    >
      {error && <p role="alert">{error}</p>}
      {settings && (
        <>
          <SettingsSection title="Weather">
            <SettingsGroup>
              <SettingsSelect
                label="Weather provider"
                value={settings.provider}
                onChange={(provider) => void save({ provider })}
              >
                {settings.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.name}
                  </option>
                ))}
              </SettingsSelect>
              <SettingsToggle
                label="Weather intelligence"
                description="Use MET Norway forecasts and Open-Meteo location search for non-commercial use."
                checked={settings.enabled}
                onChange={(enabled) => void save({ enabled })}
              />
              <SettingsInput
                label="Default location"
                description="Enter a city and country. Aria asks when the name has multiple matches."
                value={location}
                maxLength={160}
                onChange={(event) => setLocation(event.target.value)}
                onBlur={() => {
                  if (!location.trim() || location.trim().length >= 2)
                    void save({ defaultLocation: location.trim() || undefined });
                }}
              />
              <SettingsSelect
                label="Temperature"
                value={settings.temperature}
                onChange={(temperature) =>
                  void save({ temperature: temperature as WeatherSettings['temperature'] })
                }
              >
                <option value="celsius">Celsius</option>
                <option value="fahrenheit">Fahrenheit</option>
              </SettingsSelect>
              <SettingsSelect
                label="Wind speed"
                value={settings.wind}
                onChange={(wind) => void save({ wind: wind as WeatherSettings['wind'] })}
              >
                <option value="m/s">m/s</option>
                <option value="km/h">km/h</option>
                <option value="mph">mph</option>
              </SettingsSelect>
            </SettingsGroup>
          </SettingsSection>
          <SettingsSection title="Sources and privacy">
            <p>
              Connection status:{' '}
              {settings.providerStatus === 'not_checked'
                ? 'not checked this session'
                : settings.providerStatus}
              .
            </p>
            <p>
              Forecasts: MET Norway, CC BY 4.0. Location data: GeoNames via Open-Meteo, CC BY 4.0.
              Open-Meteo’s free service is for non-commercial use.
            </p>
            <p>
              Requests go directly to these providers and disclose your IP address and the requested
              location. Forecasts are cached locally ({settings.cachedEntries} entries). Device
              location is currently unavailable; enter a location instead.
            </p>
            <button
              type="button"
              onClick={() =>
                void window.aria
                  ?.clearWeatherCache()
                  .then(setSettings)
                  .catch(() => setError('The cache could not be cleared.'))
              }
            >
              Clear weather cache
            </button>
          </SettingsSection>
        </>
      )}
    </SettingsPage>
  );
}
