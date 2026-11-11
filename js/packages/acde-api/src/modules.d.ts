declare module 'acde:fs' {
  import type { AcdePage } from '@dopame/acde-api'
  const fs: NonNullable<AcdePage['fs']>
  export { fs }
  export default fs
}

declare module 'acde:office' {
  import type { AcdePage } from '@dopame/acde-api'
  const office: NonNullable<AcdePage['office']>
  export { office }
  export default office
}

declare module 'acde:terminal' {
  import type { AcdePage } from '@dopame/acde-api'
  const terminal: NonNullable<AcdePage['terminal']>
  export { terminal }
  export default terminal
}

declare module 'acde:network' {
  import type { AcdePage } from '@dopame/acde-api'
  const network: NonNullable<AcdePage['network']>
  export { network }
  export default network
}

declare module 'acde:system' {
  import type { AcdePage } from '@dopame/acde-api'
  const system: NonNullable<AcdePage['system']>
  export { system }
  export default system
}

declare module 'acde:display' {
  import type { AcdePage } from '@dopame/acde-api'
  const display: NonNullable<AcdePage['display']>
  export { display }
  export default display
}

declare module 'acde:audio' {
  import type { AcdePage } from '@dopame/acde-api'
  const audio: NonNullable<AcdePage['audio']>
  export { audio }
  export default audio
}

declare module 'acde:power' {
  import type { AcdePage } from '@dopame/acde-api'
  const power: NonNullable<AcdePage['power']>
  export { power }
  export default power
}

declare module 'acde:devices' {
  import type { AcdePage } from '@dopame/acde-api'
  const devices: NonNullable<AcdePage['devices']>
  export { devices }
  export default devices
}

declare module 'acde:windows' {
  import type { AcdePage } from '@dopame/acde-api'
  const windows: NonNullable<AcdePage['windows']>
  export { windows }
  export default windows
}

declare module 'acde:apps' {
  import type { AcdePage } from '@dopame/acde-api'
  const apps: NonNullable<AcdePage['apps']>
  export { apps }
  export default apps
}

declare module 'acde:desktop' {
  import type { AcdePage } from '@dopame/acde-api'
  const desktop: NonNullable<AcdePage['desktop']>
  export { desktop }
  export default desktop
}

declare module 'acde:desktops' {
  import type { AcdePage } from '@dopame/acde-api'
  const desktops: NonNullable<AcdePage['desktops']>
  export { desktops }
  export default desktops
}

declare module 'acde:session' {
  import type { AcdePage } from '@dopame/acde-api'
  const session: NonNullable<AcdePage['session']>
  export { session }
  export default session
}

declare module 'acde:inspect' {
  import type { AcdePage } from '@dopame/acde-api'
  const inspect: NonNullable<AcdePage['inspect']>
  export { inspect }
  export default inspect
}

declare module 'acde:open' {
  import type { AcdePage } from '@dopame/acde-api'
  const open: NonNullable<AcdePage['open']>
  export { open }
  export default open
}

declare module 'acde:openPath' {
  import type { AcdePage } from '@dopame/acde-api'
  const openPath: NonNullable<AcdePage['openPath']>
  export { openPath }
  export default openPath
}

declare module 'acde:handlers' {
  import type { AcdePage } from '@dopame/acde-api'
  const handlers: NonNullable<AcdePage['handlers']>
  export { handlers }
  export default handlers
}

declare module 'acde:setDefault' {
  import type { AcdePage } from '@dopame/acde-api'
  const setDefault: NonNullable<AcdePage['setDefault']>
  export { setDefault }
  export default setDefault
}

declare module 'acde:window' {
  import type { AcdePage } from '@dopame/acde-api'
  const self: NonNullable<AcdePage['window']>
  export { self as window }
  export default self
}

declare module 'acde:*' {
  const service: unknown
  export default service
}
