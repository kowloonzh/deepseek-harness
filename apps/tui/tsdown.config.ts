import { defineConfig } from 'tsdown'

export default defineConfig([{
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
}, {
  // The Host plugin behind composer suggestions, loaded by the Web profile from this path; its
  // Host packages stay external and resolve from this package at load time.
  entry: { 'host/next-prompt': 'lib/types/host/next-prompt.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: ['lib/host/*.js'],
}])
