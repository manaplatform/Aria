import type { DesktopBridge } from '@aria/shared';
declare global {
  interface Window {
    aria?: DesktopBridge;
  }
}
