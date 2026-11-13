import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { flushPersistence } from '../src/stores/workspaceStore';

afterEach(async () => {
  cleanup();
  await flushPersistence();
});
