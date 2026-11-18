import type { Devd } from './devd.ts'

export interface GuestUser {
  readonly user: string
  readonly home: string
}

export const GUEST_PASSWORD = 'dopame-dev'
export const GUEST_PASSWORD_ENV = 'ACDEV_VM_PASSWORD'

const SETUP = [
  'set -e',
  'session=$(loginctl show-seat seat0 --property=ActiveSession --value)',
  '[ -n "$session" ] || { echo "no session is active on seat0: log in in the guest first" >&2; exit 3; }',
  'user=$(loginctl show-session "$session" --property=Name --value)',
  'home=$(getent passwd "$user" | cut -d: -f6)',
  'printf \'%s:%s\\n\' "$user" "$1" | chpasswd',
  'faillock --user "$user" --reset',
  'printf \'%s\\n%s\\n\' "$user" "$home"',
].join('\n')

export function guestPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env[GUEST_PASSWORD_ENV] || GUEST_PASSWORD
}

export async function prepareGuest(devd: Pick<Devd, 'run'>, password: string): Promise<GuestUser> {
  let out = ''
  let err = ''
  const code = await devd.run(['/bin/sh', '-c', SETUP, 'sh', password], {
    stdout: (chunk) => {
      out += chunk.toString()
    },
    stderr: (chunk) => {
      err += chunk.toString()
    },
  })
  const [user, home] = out.split('\n').map((line) => line.trim())
  if (code !== 0 || !user || !home) {
    const said = err.trim() || out.trim() || 'no output'
    throw new Error(`acdev test --vm: setting up the session user in the guest failed (${code}): ${said}`)
  }
  return { user, home }
}
