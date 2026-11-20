#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      if (invocation.profile === 'tui') {
        if (invocation.patches.length > 0) {
          process.stderr.write('dsh tui: --patch is not supported; the TUI uses the web profile configuration as-is\n')
          process.exitCode = 1
          break
        }
        const loaded = await loadTuiModule()
        if (!isTuiModule(loaded)) throw new Error('dsh tui: package does not export runTui')
        const exitCode = await loaded.runTui({
          args: invocation.args,
          entrypoint: process.argv[1],
          execArgv: process.execArgv,
          env: process.env,
        })
        if (exitCode !== 0) process.exitCode = exitCode
        break
      }
      const { runProfile } = await import('./profile-boot.ts')
      try {
        await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

interface TuiModule {
  runTui(options: {
    readonly args: readonly string[]
    readonly entrypoint?: string | undefined
    readonly execArgv?: readonly string[]
    readonly env?: NodeJS.ProcessEnv
  }): Promise<number>
}

function isTuiModule(value: unknown): value is TuiModule {
  return typeof value === 'object' && value !== null
    && 'runTui' in value && typeof value.runTui === 'function'
}

/**
 * Source launches follow the checked-out TUI; package launches use its built entry.
 * @returns the module exporting `runTui`.
 */
function loadTuiModule(): Promise<unknown> {
  const specifier = import.meta.url.endsWith('/src/bin.ts')
    ? new URL('../../tui/src/index.ts', import.meta.url).href
    : import.meta.resolve('@deepseek-ai/dsh-tui-app')
  return import(specifier)
}

if (import.meta.main) {
  await runCli()
}
