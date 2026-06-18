import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/services/compactionEngine.ts', 'src/durable/schema.ts', 'src/durable/repository.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 60,
        functions: 50,
      },
    },
  },
});
