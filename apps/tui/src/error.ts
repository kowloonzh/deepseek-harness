/** Stable failures surfaced by the TUI entrypoint. */
export type TuiErrorCode =
  | 'TUI_NOT_TTY'
  | 'HOST_URL_INVALID'
  | 'HOST_URL_TOKEN_MISSING'
  | 'HOST_START_FAILED'
  | 'HOST_READY_TIMEOUT'
  | 'HOST_EXITED'
  | 'CONNECT_FAILED'
  | 'CONNECTION_TIMEOUT'
  | 'NOT_CONNECTED'
  | 'CLIPBOARD_UNAVAILABLE'
  | 'CLIPBOARD_READ_FAILED'
  | 'CLIPBOARD_WRITE_FAILED'
  | 'CLIPBOARD_IMAGE_UNSUPPORTED'
  | 'CLIPBOARD_IMAGE_TOO_LARGE'
  | 'SESSION_REQUIRED'
  | 'REMOTE_FAILED'

/** Typed failure with an actionable, user-facing message. */
export class TuiError extends Error {
  /**
   * @param code - stable failure category.
   * @param message - actionable user-facing explanation.
   * @param options - optional cause and cleanup detail.
   * @param remoteCode - stable code returned by the Host Remote boundary.
   */
  constructor(
    readonly code: TuiErrorCode,
    message: string,
    options?: ErrorOptions,
    readonly remoteCode?: string,
  ) {
    super(message, options)
    this.name = 'TuiError'
  }
}

/** Keep tokenized URLs out of diagnostics. */
export function safeUrl(url: URL): string {
  const copy = new URL(url)
  copy.search = ''
  copy.hash = ''
  return copy.href
}
