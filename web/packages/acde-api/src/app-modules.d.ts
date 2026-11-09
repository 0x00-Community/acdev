declare module 'acde:fs' {
  const fs: import('./page').AcdeFs
  export { fs, fs as default }
}
declare module 'acde:office' {
  const office: import('./page').AcdeOffice
  export { office, office as default }
}
declare module 'acde:terminal' {
  const terminal: import('./page').AcdeTerminals
  export { terminal, terminal as default }
}
declare module 'acde:network' {
  const network: import('./page').AcdeNetwork
  export { network, network as default }
}
declare module 'acde:launch' {
  const launch: import('./page').AcdeLaunch
  export { launch, launch as default }
}
declare module 'acde:apps' {
  const apps: import('./page').AcdeAppList
  export { apps, apps as default }
}
declare module 'acde:open' {
  const open: (app: string, request?: Record<string, unknown> | null) => Promise<{ window: number }>
  export { open, open as default }
}
declare module 'acde:openPath' {
  const openPath: import('./page').AcdeOpenFiles['openPath']
  export { openPath, openPath as default }
}
declare module 'acde:handlers' {
  const handlers: import('./page').AcdeOpenFiles['handlers']
  export { handlers, handlers as default }
}
declare module 'acde:window' {
  const self: import('./page').AcdeWindow
  export { self as window, self as default }
}
declare module 'acde:*' {
  const service: unknown
  export default service
}
