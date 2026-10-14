import path from 'node:path';
import { defineConfig } from 'vitest/config';

const common = path.resolve(__dirname, 'libs/ts-common/src');

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@travelduty\/common$/, replacement: `${common}/index.ts` },
      { find: /^@travelduty\/common\/testing$/, replacement: `${common}/testing.ts` },
    ],
  },
  test: {
    include: ['libs/ts-common/test/**/*.test.ts', 'services/gateway/test/**/*.test.ts', 'services/booking-service/test/**/*.test.ts', 'services/synthetics/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
