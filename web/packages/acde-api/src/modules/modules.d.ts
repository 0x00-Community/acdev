declare module 'acde:fs' {
  const fs: import('@dopame/acde-api').AcdeModules['fs']
  export { fs, fs as default }
}
declare module 'acde:office' {
  const office: import('@dopame/acde-api').AcdeModules['office']
  export { office, office as default }
}
declare module 'acde:terminal' {
  const terminal: import('@dopame/acde-api').AcdeModules['terminal']
  export { terminal, terminal as default }
}
declare module 'acde:network' {
  const network: import('@dopame/acde-api').AcdeModules['network']
  export { network, network as default }
}
declare module 'acde:windows' {
  const windows: import('@dopame/acde-api').AcdeModules['windows']
  export { windows, windows as default }
}
declare module 'acde:launch' {
  const launch: import('@dopame/acde-api').AcdeModules['launch']
  export { launch, launch as default }
}
declare module 'acde:packages' {
  const packages: import('@dopame/acde-api').AcdeModules['packages']
  export { packages, packages as default }
}
declare module 'acde:apps' {
  const apps: import('@dopame/acde-api').AcdeModules['apps']
  export { apps, apps as default }
}
declare module 'acde:desktop' {
  const desktop: import('@dopame/acde-api').AcdeModules['desktop']
  export { desktop, desktop as default }
}
declare module 'acde:desktops' {
  const desktops: import('@dopame/acde-api').AcdeModules['desktops']
  export { desktops, desktops as default }
}
declare module 'acde:session' {
  const session: import('@dopame/acde-api').AcdeModules['session']
  export { session, session as default }
}
declare module 'acde:inspect' {
  const inspect: import('@dopame/acde-api').AcdeModules['inspect']
  export { inspect, inspect as default }
}
declare module 'acde:open' {
  const open: import('@dopame/acde-api').AcdeModules['open']
  export { open, open as default }
}
declare module 'acde:openPath' {
  const openPath: import('@dopame/acde-api').AcdeModules['openPath']
  export { openPath, openPath as default }
}
declare module 'acde:handlers' {
  const handlers: import('@dopame/acde-api').AcdeModules['handlers']
  export { handlers, handlers as default }
}
declare module 'acde:permissions' {
  const permissions: import('@dopame/acde-api').AcdeModules['permissions']
  export { permissions, permissions as default }
}
declare module 'acde:setDefault' {
  const setDefault: import('@dopame/acde-api').AcdeModules['setDefault']
  export { setDefault, setDefault as default }
}
declare module 'acde:window' {
  const self: import('@dopame/acde-api').AcdeModules['window']
  export { self as window, self as default }
}
declare module 'acde:capabilities' {
  const capabilities: import('@dopame/acde-api').AcdeModules['capabilities']
  export { capabilities, capabilities as default }
}
declare module 'acde:*' {
  const service: unknown
  export default service
}
