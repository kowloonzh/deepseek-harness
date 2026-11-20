/** Clipboard image discovery through an injected command runner. */

import { describe, expect, it } from 'vitest'
import {
  readClipboard,
  writeClipboardText,
  type ClipboardCommandResult,
  type ClipboardCommandRunner,
} from '../src/clipboard.ts'

const PNG = Uint8Array.of(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x01, 0x02, 0x03,
)

describe('clipboard capture', () => {
  it('prefers a supported Wayland image and preserves its bytes as base64', async () => {
    const run = fixtureRunner({
      'wl-paste --list-types': ok('text/plain\nimage/png\n'),
      'wl-paste --type image/png --no-newline': ok(PNG),
    })
    const content = await readClipboard({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
      maxImageBytes: 1024,
    })
    expect(content).toMatchObject({
      kind: 'image',
      mediaType: 'image/png',
      bytes: PNG.length,
      name: 'pasted-image.png',
    })
    expect(content?.kind === 'image' ? Buffer.from(content.data, 'base64') : undefined).toEqual(Buffer.from(PNG))
  })

  it('falls back to plain text when the clipboard has no image', async () => {
    const run = fixtureRunner({
      'wl-paste --list-types': ok('text/plain;charset=utf-8\n'),
      'wl-paste --type text/plain;charset=utf-8 --no-newline': ok('hello\nworld'),
    })
    await expect(readClipboard({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
    })).resolves.toEqual({ kind: 'text', text: 'hello\nworld' })
  })

  it('reports an unsupported image instead of treating it as text', async () => {
    const run = fixtureRunner({
      'wl-paste --list-types': ok('image/bmp\n'),
    })
    await expect(readClipboard({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
    })).rejects.toMatchObject({ code: 'CLIPBOARD_IMAGE_UNSUPPORTED' })
  })

  it('enforces the configured image byte cap', async () => {
    const run = fixtureRunner({
      'wl-paste --list-types': ok('image/png\n'),
      'wl-paste --type image/png --no-newline': ok(PNG),
    })
    await expect(readClipboard({
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
      maxImageBytes: 4,
    })).rejects.toMatchObject({ code: 'CLIPBOARD_IMAGE_TOO_LARGE' })
  })

  it('writes selected text through the Wayland clipboard and captures stdin', async () => {
    let written = ''
    const run: ClipboardCommandRunner = async (command, args, options) => {
      expect([command, ...args]).toEqual(['wl-copy'])
      written = new TextDecoder().decode(options.input)
      return ok('')
    }
    await writeClipboardText('selected text', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      run,
    })
    expect(written).toBe('selected text')
  })

  it('falls back to xclip when wl-copy is unavailable', async () => {
    const calls: string[] = []
    const run: ClipboardCommandRunner = async (command, args, options) => {
      calls.push([command, ...args].join(' '))
      if (command === 'wl-copy') return undefined
      expect(new TextDecoder().decode(options.input)).toBe('selected text')
      return ok('')
    }
    await writeClipboardText('selected text', {
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' },
      run,
    })
    expect(calls).toEqual(['wl-copy', 'xclip -selection clipboard -in'])
  })
})

function fixtureRunner(responses: Readonly<Record<string, ReturnType<typeof ok>>>): ClipboardCommandRunner {
  return async (command: string, args: readonly string[]): Promise<ClipboardCommandResult | undefined> => {
    const key = [command, ...args].join(' ')
    return responses[key]
  }
}

function ok(stdout: string | Uint8Array): { readonly ok: true; readonly stdout: Uint8Array } {
  return {
    ok: true,
    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
  }
}
