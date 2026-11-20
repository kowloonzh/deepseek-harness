/** System clipboard capture for text and supported raster images. */

import { spawn } from 'node:child_process'
import { TuiError } from './error.ts'

/** Raster formats accepted by the DSH prompt attachment path. */
export type ClipboardImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

/** One image captured from the operating-system clipboard. */
export interface ClipboardImage {
  readonly kind: 'image'
  readonly mediaType: ClipboardImageMediaType
  /** Canonical base64 encoding of the exact clipboard bytes. */
  readonly data: string
  readonly bytes: number
  readonly name: string
}

/** Plain text captured from the operating-system clipboard. */
export interface ClipboardText {
  readonly kind: 'text'
  readonly text: string
}

/** Content read from the operating-system clipboard. */
export type ClipboardContent = ClipboardImage | ClipboardText

/** Limits applied while launching one clipboard command. */
export interface ClipboardCommandOptions {
  readonly timeoutMs?: number
  readonly maxBytes?: number
  readonly input?: Uint8Array
}

/** Completed clipboard command with captured stdout. */
export interface ClipboardCommandResult {
  readonly ok: boolean
  readonly stdout: Uint8Array
}

/** Injectable clipboard-command runner used by tests. */
export type ClipboardCommandRunner = (
  command: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
) => Promise<ClipboardCommandResult | undefined>

/** Inputs for one clipboard read. */
export interface ReadClipboardOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly run?: ClipboardCommandRunner
  readonly maxImageBytes?: number
}

/** Inputs for one clipboard text write. */
export interface WriteClipboardOptions {
  readonly env?: NodeJS.ProcessEnv
  readonly platform?: NodeJS.Platform
  readonly run?: ClipboardCommandRunner
}

const DEFAULT_MAX_IMAGE_BYTES = 50 * 1024 * 1024
const LIST_TIMEOUT_MS = 1_500
const READ_TIMEOUT_MS = 10_000
const WRITE_TIMEOUT_MS = 3_000
const IMAGE_TARGETS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/**
 * Read an image first, then fall back to plain text.
 *
 * A missing desktop clipboard integration fails with an actionable TUI error;
 * an available but empty clipboard returns `undefined`.
 *
 * @param options - platform, environment, command runner, and image byte cap.
 * @returns captured content, or undefined when the clipboard is empty.
 */
export async function readClipboard(options: ReadClipboardOptions = {}): Promise<ClipboardContent | undefined> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const run = options.run ?? runClipboardCommand
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES

  if (env.TERMUX_VERSION !== undefined) {
    throw new TuiError(
      'CLIPBOARD_UNAVAILABLE',
      'clipboard access is unavailable in Termux; install Termux:API and the termux-api package, then use the terminal paste shortcut',
    )
  }
  if (platform === 'linux') return readLinuxClipboard({ env, run, maxImageBytes })
  if (platform === 'darwin') return readDarwinClipboard({ run, maxImageBytes })
  if (platform === 'win32') return readWindowsClipboard({ run, maxImageBytes })
  throw new TuiError('CLIPBOARD_UNAVAILABLE', `clipboard capture is not supported on ${platform}`)
}

/**
 * Write plain text to the operating-system clipboard.
 * @param text - exact text to publish.
 * @param options - platform, environment, and command runner.
 */
export async function writeClipboardText(
  text: string,
  options: WriteClipboardOptions = {},
): Promise<void> {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const run = options.run ?? runClipboardCommand
  const commands: Array<{ readonly command: string; readonly args: readonly string[] }> = []
  if (env.TERMUX_VERSION !== undefined) {
    commands.push({ command: 'termux-clipboard-set', args: [] })
  } else if (platform === 'linux') {
    if (env.WAYLAND_DISPLAY !== undefined || env.XDG_SESSION_TYPE === 'wayland') {
      commands.push({ command: 'wl-copy', args: [] })
    }
    if (env.DISPLAY !== undefined) {
      commands.push({ command: 'xclip', args: ['-selection', 'clipboard', '-in'] })
    }
  } else if (platform === 'darwin') {
    commands.push({ command: 'pbcopy', args: [] })
  } else if (platform === 'win32') {
    commands.push({
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_WRITE_SCRIPT],
    })
  } else {
    throw new TuiError('CLIPBOARD_UNAVAILABLE', `clipboard writing is not supported on ${platform}`)
  }
  if (commands.length === 0) {
    throw new TuiError(
      'CLIPBOARD_UNAVAILABLE',
      'clipboard writing needs WAYLAND_DISPLAY with wl-clipboard, or DISPLAY with xclip',
    )
  }

  let available = false
  for (const command of commands) {
    const result = await run(command.command, command.args, {
      timeoutMs: WRITE_TIMEOUT_MS,
      input: new TextEncoder().encode(text),
    })
    if (result === undefined) continue
    available = true
    if (result.ok) return
  }
  if (!available) {
    throw new TuiError(
      'CLIPBOARD_UNAVAILABLE',
      'clipboard tooling was not found; install wl-clipboard (wl-copy) for Wayland or xclip for X11',
    )
  }
  throw new TuiError('CLIPBOARD_WRITE_FAILED', 'clipboard tooling could not write the selected text')
}

/** Identify a supported image from its file signature. */
export function sniffImageMediaType(bytes: Uint8Array): ClipboardImageMediaType | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return 'image/gif'
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'image/webp'
  return undefined
}

interface LinuxReadOptions {
  readonly env: NodeJS.ProcessEnv
  readonly run: ClipboardCommandRunner
  readonly maxImageBytes: number
}

type BackendResult =
  | { readonly kind: 'content'; readonly content: ClipboardContent }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'unsupported-image' }

async function readLinuxClipboard(options: LinuxReadOptions): Promise<ClipboardContent | undefined> {
  const backends: Array<() => Promise<BackendResult>> = []
  if (options.env.WAYLAND_DISPLAY !== undefined || options.env.XDG_SESSION_TYPE === 'wayland') {
    backends.push(() => readTargetListClipboard({
      command: 'wl-paste',
      listArgs: ['--list-types'],
      dataArgs: type => ['--type', type, '--no-newline'],
      textArgs: ['--no-newline'],
      run: options.run,
      maxImageBytes: options.maxImageBytes,
    }))
  }
  if (options.env.DISPLAY !== undefined) {
    backends.push(() => readTargetListClipboard({
      command: 'xclip',
      listArgs: ['-selection', 'clipboard', '-t', 'TARGETS', '-o'],
      dataArgs: type => ['-selection', 'clipboard', '-t', type, '-o'],
      textArgs: ['-selection', 'clipboard', '-o'],
      run: options.run,
      maxImageBytes: options.maxImageBytes,
    }))
  }
  if (backends.length === 0) {
    throw new TuiError(
      'CLIPBOARD_UNAVAILABLE',
      'clipboard access needs WAYLAND_DISPLAY with wl-clipboard, or DISPLAY with xclip',
    )
  }

  let sawAvailableBackend = false
  let lastFailure: string | undefined
  for (const read of backends) {
    const result = await read()
    if (result.kind === 'unavailable') continue
    sawAvailableBackend = true
    if (result.kind === 'content') return result.content
    if (result.kind === 'empty') return undefined
    if (result.kind === 'unsupported-image') {
      throw new TuiError(
        'CLIPBOARD_IMAGE_UNSUPPORTED',
        'the clipboard image is not PNG, JPEG, WebP, or GIF; copy one of those formats',
      )
    }
    lastFailure = result.message
  }
  if (lastFailure !== undefined) {
    throw new TuiError('CLIPBOARD_READ_FAILED', lastFailure)
  }
  if (!sawAvailableBackend) {
    throw new TuiError(
      'CLIPBOARD_UNAVAILABLE',
      'clipboard tooling was not found; install wl-clipboard (wl-paste) for Wayland or xclip for X11',
    )
  }
  return undefined
}

interface TargetListOptions {
  readonly command: string
  readonly listArgs: readonly string[]
  readonly dataArgs: (type: string) => readonly string[]
  readonly textArgs: readonly string[]
  readonly run: ClipboardCommandRunner
  readonly maxImageBytes: number
}

async function readTargetListClipboard(options: TargetListOptions): Promise<BackendResult> {
  const listed = await options.run(options.command, options.listArgs, {
    timeoutMs: LIST_TIMEOUT_MS,
    maxBytes: 64 * 1024,
  })
  if (listed === undefined) return { kind: 'unavailable' }
  if (!listed.ok) {
    return { kind: 'failed', message: `${options.command} could not access the clipboard` }
  }
  const targets = new TextDecoder().decode(listed.stdout)
    .split(/\r?\n/u)
    .map(value => value.trim())
    .filter(Boolean)
  const imageTarget = selectImageTarget(targets)
  if (imageTarget !== undefined) {
    const image = await readImageBytes(options, imageTarget)
    if (image !== undefined) return image
  }
  if (targets.some(target => target.toLowerCase().startsWith('image/'))) {
    return { kind: 'unsupported-image' }
  }

  const textTarget = targets.find(isTextTarget)
  const textArgs = textTarget === undefined ? options.textArgs : options.dataArgs(textTarget)
  const text = await options.run(options.command, textArgs, {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: Math.max(options.maxImageBytes, 8 * 1024 * 1024),
  })
  if (text === undefined) return { kind: 'unavailable' }
  if (!text.ok) return { kind: 'failed', message: `${options.command} could not read clipboard text` }
  if (text.stdout.length === 0) return { kind: 'empty' }
  return { kind: 'content', content: { kind: 'text', text: new TextDecoder().decode(text.stdout) } }
}

async function readImageBytes(
  options: TargetListOptions,
  target: string,
): Promise<BackendResult | undefined> {
  const image = await options.run(options.command, options.dataArgs(target), {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: Math.ceil(options.maxImageBytes * 2),
  })
  if (image === undefined) return { kind: 'unavailable' }
  if (!image.ok) return { kind: 'failed', message: `${options.command} could not read the clipboard image` }
  if (image.stdout.length === 0) return { kind: 'empty' }
  return { kind: 'content', content: encodeImage(image.stdout, options.maxImageBytes, 'pasted-image') }
}

interface NativeReadOptions {
  readonly run: ClipboardCommandRunner
  readonly maxImageBytes: number
}

async function readDarwinClipboard(options: NativeReadOptions): Promise<ClipboardContent | undefined> {
  const image = await options.run('osascript', ['-l', 'JavaScript', '-e', DARWIN_IMAGE_SCRIPT], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: Math.ceil(options.maxImageBytes * 2),
  })
  if (image?.ok) {
    const bytes = decodeBase64(image.stdout)
    if (bytes !== undefined && bytes.length > 0) return encodeImage(bytes, options.maxImageBytes, 'pasted-image')
  }
  const text = await options.run('pbpaste', [], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: 8 * 1024 * 1024,
  })
  if (text === undefined) {
    throw new TuiError('CLIPBOARD_UNAVAILABLE', 'clipboard access is unavailable; pbpaste was not found')
  }
  if (!text.ok) throw new TuiError('CLIPBOARD_READ_FAILED', 'pbpaste could not read the clipboard')
  return text.stdout.length === 0
    ? undefined
    : { kind: 'text', text: new TextDecoder().decode(text.stdout) }
}

async function readWindowsClipboard(options: NativeReadOptions): Promise<ClipboardContent | undefined> {
  const image = await options.run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_IMAGE_SCRIPT,
  ], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: Math.ceil(options.maxImageBytes * 2),
  })
  if (image?.ok) {
    const bytes = decodeBase64(image.stdout)
    if (bytes !== undefined && bytes.length > 0) return encodeImage(bytes, options.maxImageBytes, 'pasted-image')
  }
  const text = await options.run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_TEXT_SCRIPT,
  ], {
    timeoutMs: READ_TIMEOUT_MS,
    maxBytes: 12 * 1024 * 1024,
  })
  if (text === undefined) {
    throw new TuiError('CLIPBOARD_UNAVAILABLE', 'clipboard access is unavailable; powershell.exe was not found')
  }
  if (!text.ok) throw new TuiError('CLIPBOARD_READ_FAILED', 'PowerShell could not read the clipboard')
  const bytes = decodeBase64(text.stdout)
  if (bytes === undefined || bytes.length === 0) return undefined
  return { kind: 'text', text: new TextDecoder().decode(bytes) }
}

function selectImageTarget(targets: readonly string[]): string | undefined {
  const normalized = targets.map(target => ({
    raw: target,
    base: target.split(';', 1)[0]?.trim().toLowerCase() ?? '',
  }))
  for (const preferred of IMAGE_TARGETS) {
    const match = normalized.find(target => target.base === preferred)
    if (match !== undefined) return match.raw
  }
  return undefined
}

function isTextTarget(target: string): boolean {
  const normalized = target.toLowerCase()
  return normalized === 'utf8_string'
    || normalized === 'string'
    || normalized === 'text'
    || normalized.startsWith('text/')
}

function encodeImage(bytes: Uint8Array, maxImageBytes: number, stem: string): ClipboardImage {
  if (bytes.length > maxImageBytes) {
    throw new TuiError(
      'CLIPBOARD_IMAGE_TOO_LARGE',
      `clipboard image is ${formatBytes(bytes.length)}; the configured limit is ${formatBytes(maxImageBytes)}`,
    )
  }
  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === undefined) {
    throw new TuiError(
      'CLIPBOARD_IMAGE_UNSUPPORTED',
      'clipboard bytes are not a PNG, JPEG, WebP, or GIF image',
    )
  }
  return {
    kind: 'image',
    mediaType,
    data: Buffer.from(bytes).toString('base64'),
    bytes: bytes.length,
    name: `${stem}.${extension(mediaType)}`,
  }
}

function decodeBase64(bytes: Uint8Array): Uint8Array | undefined {
  const value = new TextDecoder().decode(bytes).trim()
  if (value === '') return undefined
  try {
    return Uint8Array.from(Buffer.from(value, 'base64'))
  } catch (error) {
    void error
    return undefined
  }
}

function extension(mediaType: ClipboardImageMediaType): string {
  if (mediaType === 'image/png') return 'png'
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  return 'gif'
}

function formatBytes(value: number): string {
  if (value < 1024) return `${String(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return ''
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function runClipboardCommand(
  command: string,
  args: readonly string[],
  options: ClipboardCommandOptions,
): Promise<ClipboardCommandResult | undefined> {
  return new Promise((resolve) => {
    let settled = false
    const chunks: Uint8Array[] = []
    let bytes = 0
    const child = spawn(command, [...args], {
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const finish = (result: ClipboardCommandResult | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish({ ok: false, stdout: joined(chunks) })
    }, options.timeoutMs ?? READ_TIMEOUT_MS)
    child.once('error', () => { finish(undefined) })
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        child.kill('SIGTERM')
        finish({ ok: false, stdout: joined([...chunks, chunk]) })
        return
      }
      chunks.push(chunk)
    })
    child.once('close', (code) => {
      finish({ ok: code === 0, stdout: joined(chunks) })
    })
    child.stdin.end(options.input === undefined ? undefined : Buffer.from(options.input))
  })
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

const DARWIN_IMAGE_SCRIPT = `
ObjC.import('AppKit');
ObjC.import('Foundation');
const board = $.NSPasteboard.generalPasteboard;
let data = board.dataForType('public.png');
if (!data) {
  const tiff = board.dataForType('public.tiff');
  if (tiff) {
    const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
    if (rep) data = rep.representationUsingTypeProperties($.NSPNGFileType, $());
  }
}
data ? data.base64EncodedStringWithOptions(0).js : '';
`

const WINDOWS_IMAGE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image) {
  $stream = New-Object System.IO.MemoryStream
  $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
  [Convert]::ToBase64String($stream.ToArray())
}
`

const WINDOWS_TEXT_SCRIPT = `
$text = Get-Clipboard -Raw
if ($null -ne $text) {
  [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($text))
}
`

const WINDOWS_WRITE_SCRIPT = `
$text = [Console]::In.ReadToEnd()
Set-Clipboard -Value $text
`
