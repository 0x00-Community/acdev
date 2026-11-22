import { randomBytes } from 'node:crypto'
import { basename, posix } from 'node:path'
import { Devd } from './devd.ts'

export interface GuestUser {
  readonly user: string
  readonly home: string
}

export interface GuestOwner extends GuestUser {
  readonly uid: number
}

export const GUEST_PASSWORD = 'dopame-dev'
export const GUEST_PASSWORD_ENV = 'ACDEV_VM_PASSWORD'

const WHO = [
  'set -e',
  'session=$(loginctl show-seat seat0 --property=ActiveSession --value)',
  '[ -n "$session" ] || { echo "no session is active on seat0: log in in the guest first" >&2; exit 3; }',
  'user=$(loginctl show-session "$session" --property=Name --value)',
  'home=$(getent passwd "$user" | cut -d: -f6)',
]

const SETUP = [
  ...WHO,
  'printf \'%s:%s\\n\' "$user" "$1" | chpasswd',
  'faillock --user "$user" --reset',
  'printf \'%s\\n%s\\n\' "$user" "$home"',
].join('\n')

const OWNER = [...WHO, 'printf \'%s\\n%s\\n%s\\n\' "$user" "$home" "$(id -u "$user")"'].join('\n')

const HAND_OVER = 'set -e; chown -R "$1:" "$2"; chmod 700 "$2"'

type Runs = Pick<Devd, 'run'>

async function script(devd: Runs, what: string, text: string, args: readonly string[]): Promise<string[]> {
  let out = ''
  let err = ''
  const code = await devd.run(['/bin/sh', '-c', text, 'sh', ...args], {
    stdout: (chunk) => {
      out += chunk.toString()
    },
    stderr: (chunk) => {
      err += chunk.toString()
    },
  })
  const lines = out.split('\n').map((line) => line.trim())
  if (code !== 0) throw new Error(`${what} failed in the guest (${code}): ${err.trim() || out.trim() || 'no output'}`)
  return lines
}

export const LOGIN_USER = 'tester'

const LOGIN = [
  'faillock --user "$1" --reset 2>/dev/null || true',
  'code=0',
  'acdes greeter login "$1" < "$2" || code=$?',
  'rm -f "$2"',
  'exit $code',
].join('\n')

const LOGIN_ANSWERS: Readonly<Record<number, string>> = {
  1: 'the login page turned the password down, or no session came up within 30 s',
  2: 'acdes refused: not a guest acdev started, or an acdes without "greeter login" (update acdes)',
  3: 'no login page is waiting (the guest is still starting, or another user is logged in)',
  127: 'this acdes has no "greeter login" (update acdes)',
}

export class LoginRefused extends Error {
  readonly code: number

  constructor(code: number, detail: string) {
    super(`vm login: ${LOGIN_ANSWERS[code] ?? `acdes greeter login exited ${code}`}${detail ? ` (${detail})` : ''}`)
    this.code = code
  }
}

export async function loginGuest(devd: Pick<Devd, 'run' | 'push'>, user: string, password: string): Promise<string> {
  const file = posix.join('/run', `acdev-login-${randomBytes(6).toString('hex')}`)
  await devd.push([{ path: file, mode: 0o600, data: Buffer.from(`${password}\n`) }])
  let out = ''
  let err = ''
  const code = await devd.run(['/bin/sh', '-c', LOGIN, 'sh', user, file], {
    stdout: (chunk) => {
      out += chunk.toString()
    },
    stderr: (chunk) => {
      err += chunk.toString()
    },
  })
  if (code !== 0) throw new LoginRefused(code, err.trim().split('\n').at(-1) ?? '')
  return out.trim() || `logged in: ${user}`
}

export function guestPassword(env: NodeJS.ProcessEnv = process.env): string {
  return env[GUEST_PASSWORD_ENV] || GUEST_PASSWORD
}

export async function prepareGuest(devd: Runs, password: string): Promise<GuestUser> {
  const [user, home] = await script(devd, 'acdev test --vm: setting up the session user', SETUP, [password])
  if (!user || !home) throw new Error('acdev test --vm: setting up the session user in the guest failed: it named no user')
  return { user, home }
}

export async function guestOwner(devd: Runs): Promise<GuestOwner> {
  const [user, home, uid] = await script(devd, 'finding the session user', OWNER, [])
  const id = Number(uid)
  if (!user || !home || !Number.isInteger(id)) throw new Error('finding the session user in the guest failed: it named no user')
  return { user, home, uid: id }
}

export async function stageInGuest(devd: Pick<Devd, 'run' | 'push'>, files: readonly string[]): Promise<string[]> {
  const owner = await guestOwner(devd)
  const root = posix.join('/run/user', String(owner.uid), 'acdev-drop')
  const dir = posix.join(root, randomBytes(6).toString('hex'))
  const placed = files.map((file) => posix.join(dir, basename(file)))
  try {
    await devd.push(files.flatMap((file, i) => Devd.files(file, placed[i]!)))
    await script(devd, 'handing the files to the session user', HAND_OVER, [owner.user, root])
  } catch (error) {
    throw new Error(`drop: could not put the files into the guest: ${error instanceof Error ? error.message : String(error)}`)
  }
  return placed
}
