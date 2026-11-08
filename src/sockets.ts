const { join } = process.getBuiltinModule('node:path')

export type Env = Readonly<Record<string, string | undefined>>

export function socketDir(env: Env = process.env): string {
  const set = env['ACDE_APP_SOCKETS']
  if (set) return set
  const id = env['ACDE_APP_ID']
  if (!id || !/^[\w-]+$/.test(id)) {
    throw new Error('acde: no ACDE_APP_SOCKETS or ACDE_APP_ID: cannot tell which unix socket directory to listen in')
  }
  const runtime = env['XDG_RUNTIME_DIR'] || `/run/user/${process.getuid?.() ?? 0}`
  return join(runtime, 'acde', 'apps', id)
}

export function socketPath(port: number, env: Env = process.env): string {
  return join(socketDir(env), `${port}.sock`)
}
