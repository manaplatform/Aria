import { useEffect, useState } from 'react';
import type { MemoryStatus } from '@aria/shared';

export function useMemoryStatus() {
  const [status, setStatus] = useState<MemoryStatus>();
  useEffect(() => {
    let subscribed = true;
    const refresh = () => {
      if (window.aria?.memoryStatus)
        void window.aria
          .memoryStatus()
          .then((value) => {
            if (subscribed) setStatus(value);
          })
          .catch(() => undefined);
    };
    refresh();
    window.addEventListener('aria:memory-settings', refresh);
    return () => {
      subscribed = false;
      window.removeEventListener('aria:memory-settings', refresh);
    };
  }, []);
  return status;
}
