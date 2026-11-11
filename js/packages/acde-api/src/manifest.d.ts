export interface PackageManifest {
  readonly desktops?: readonly DesktopManifest[]
  readonly apps?: readonly AppManifest[]
  readonly assets?: Readonly<Record<string, readonly string[]>>
  readonly services?: readonly ServiceManifest[]
}

export interface DesktopManifest {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly entry: string
  readonly services?: readonly (string | DesktopService)[]
  readonly heapMb?: number
  /**
   * The desktop's window frame: an own-origin module path (`/ui/frame.js`, under the package's `assets`) that every app
   * window whose manifest does not say `frame: false` imports after its page loaded, calling its default export with a
   * {@link WindowFrameContext}. acde draws no frame of its own: title bar, buttons and where to grab are the desktop's.
   */
  readonly frame?: string
}

export interface DesktopService {
  readonly name: string
  readonly modules?: readonly string[]
}

/** What a desktop's window frame module (`DesktopManifest.frame`) is called with, in the window's own isolate. */
export interface WindowFrameContext {
  /** The window's `acde:window` (close, minimize, requestMode, setGrabHint …). */
  readonly window: import('./page').AcdeWindow
  readonly document: Document
  readonly app: { readonly id: string; readonly label: string; readonly icon: string }
  /** The window's title now (`document.title`, `setTitle`, or the app's label). */
  readonly title: string
  /** `ACDE_FRAME_STYLE` (`mac`: traffic lights on the left; `windows`: minimize, maximize, close on the right), or null: the frame picks. */
  readonly style: 'mac' | 'windows' | null
  /** Called when the title changes. */
  onTitle(handler: (title: string) => void): void
}

export interface AppManifest {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly entry: string
  readonly capabilities?: Capabilities
  readonly heapMb?: number
  readonly size?: readonly [number, number]
  readonly multiple?: boolean
  /** Whether the window gets the desktop's frame (`DesktopManifest.frame`); default true. */
  readonly frame?: boolean
  readonly mimeTypes?: readonly string[]
  readonly backend?: AppBackend
}

export interface AppBackend {
  readonly entry: string
  readonly port?: number
}

export interface Capabilities {
  readonly fs?: boolean | { readonly roots: readonly string[] }
  readonly terminal?: boolean
  readonly office?: boolean
  readonly launch?: boolean
  readonly slots?: boolean
  readonly open?: boolean | readonly string[]
  readonly openFiles?: boolean
  readonly session?: boolean
  readonly desktops?: boolean
  readonly [service: string]: unknown
}

export interface ServiceManifest {
  readonly name: string
  readonly module: string
}
