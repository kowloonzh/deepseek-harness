import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'lib/types/index.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/*.js'],
  deps: {
    alwaysBundle: [
      /^@deepseek-ai\/dsh-api-remotes\//u,
      /^@deepseek-ai\/dsh-api-gateway\//u,
      /^@deepseek-ai\/dsh-client-connection\//u,
      /^@deepseek-ai\/dsh-typert-registry\//u,
    ],
    onlyBundle: false,
  },
})
