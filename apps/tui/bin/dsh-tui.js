#!/usr/bin/env node
// `dsh-tui`: the standalone package's executable. The TUI itself is the bundled module.
import { runStandalone } from '../lib/index.js'

process.exitCode = await runStandalone({
  args: process.argv.slice(2),
  execArgv: process.execArgv,
  env: process.env,
})
