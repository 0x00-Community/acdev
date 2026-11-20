import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REPO = resolve(import.meta.dir, '..', '..')
export const NOTICES = join(REPO, 'THIRD-PARTY-NOTICES.txt')
export const OWN = ['acdev', 'acde-hostwin', 'acdevtool', 'acdevd', 'libacde', 'acde-scene', 'acss', '@dopame/acde-api']

export function libacde(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env['ACDEV_LIBACDE'] || join(REPO, '..', 'libacde'))
}

export function noticeArgs(repo: string, lib: string, check: boolean): string[] {
  const locks = [join(repo, 'Cargo.lock'), join(repo, 'crates', 'tool', 'Cargo.lock'), join(repo, 'crates', 'devd', 'Cargo.lock')]
  return [
    join(lib, 'scripts', 'notices.ts'),
    ...locks.flatMap((lock) => ['--cargo', lock]),
    '--vendor', join(lib, 'vendor'),
    '--own', OWN.join(','),
    '--npm', join(repo, 'npm'),
    '--extra', join(lib, 'scripts', 'notices', 'extra.json'),
    '--title', 'acdev',
    '--out', join(repo, 'THIRD-PARTY-NOTICES.txt'),
    ...(check ? ['--check'] : []),
  ]
}

export function notices(check: boolean, repo = REPO, lib = libacde()): { readonly status: number; readonly output: string } {
  const script = join(lib, 'scripts', 'notices.ts')
  if (!existsSync(script)) return { status: 2, output: `notices: no ${script} (libacde checked out beside acdev, or ACDEV_LIBACDE)` }
  const bun = process.versions['bun'] ? process.execPath : 'bun'
  const ran = spawnSync(bun, noticeArgs(repo, lib, check), { encoding: 'utf8' })
  return { status: ran.status ?? 1, output: `${ran.stdout ?? ''}${ran.stderr ?? ''}${ran.error ? ran.error.message : ''}` }
}

if (import.meta.main) {
  const { status, output } = notices(process.argv.includes('--check'))
  process.stdout.write(output)
  process.exit(status)
}
