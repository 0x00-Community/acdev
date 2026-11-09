declare module 'acde:windows' {
  const windows: import('./page').AcdeWindows
  export { windows, windows as default }
}
declare module 'acde:packages' {
  const packages: import('./page').AcdePackages
  export { packages, packages as default }
}
declare module 'acde:session' {
  const session: import('./page').AcdeSession
  export { session, session as default }
}
declare module 'acde:desktops' {
  const desktops: import('./page').AcdeDesktops
  export { desktops, desktops as default }
}
declare module 'acde:inspect' {
  const inspect: import('./page').AcdeInspect
  export { inspect, inspect as default }
}
declare module 'acde:desktop' {
  const desktop: import('./page').AcdeDesktop
  export { desktop, desktop as default }
}
declare module 'acde:setDefault' {
  const setDefault: import('./page').AcdeOpenFiles['setDefault']
  export { setDefault, setDefault as default }
}
