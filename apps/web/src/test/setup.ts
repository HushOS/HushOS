import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// A loaded CI runner can take more than Testing Library's 1 s default to render a dialog's first
// async row (share-dialog's link menu missed it twice); vitest.config.ts allows CI the same slack.
configure({ asyncUtilTimeout: process.env.CI ? 10_000 : 1_000 });

afterEach(cleanup);
