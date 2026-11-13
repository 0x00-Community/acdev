const path = process.getBuiltinModule('node:path')

export type Env = Readonly<Record<string, string | undefined>>

export const WINDOWS_PATH_MAX = 107

function paths(platform: string): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix
}

export function socketDir(env: Env = process.env, platform: string = process.platform): string {
  const set = env['ACDE_APP_SOCKETS']
  if (set) return set
  const id = env['ACDE_APP_ID']
  if (!id || !/^[\w-]+$/.test(id)) {
    throw new Error('acde: no ACDE_APP_SOCKETS or ACDE_APP_ID: cannot tell which unix socket directory to listen in')
  }
  const runtime = env['XDG_RUNTIME_DIR'] || (platform === 'win32' ? '' : `/run/user/${process.getuid?.() ?? 0}`)
  if (!runtime) {
    throw new Error('acde: no ACDE_APP_SOCKETS or XDG_RUNTIME_DIR: on Windows the runtime names the directory')
  }
  return paths(platform).join(runtime, 'acde', 'apps', id)
}

export function socketPath(port: number, env: Env = process.env, platform: string = process.platform): string {
  const socket = paths(platform).join(socketDir(env, platform), `${port}.sock`)
  const bytes = Buffer.byteLength(socket)
  if (platform === 'win32' && bytes > WINDOWS_PATH_MAX) {
    const message =
      `acde: the socket path ${socket} is ${bytes} bytes, Windows allows ${WINDOWS_PATH_MAX}: use a shorter directory`
    throw Object.assign(new Error(message), { code: 'ENAMETOOLONG' })
  }
  return socket
}
