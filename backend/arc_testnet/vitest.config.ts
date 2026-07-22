import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'test/KletiaArc.test.ts' // Hardhat test run by `npx hardhat test`
    ],
  },
});
