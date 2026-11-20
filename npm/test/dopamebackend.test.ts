import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BACKEND_SCRIPT, DROPIN_SCRIPT, backendPlan, dropIns, stageBackend, stageDropIns } from '../src/vm/dopamebackend.ts'
import { PROVISION_SCRIPT } from '../src/vm/provision.ts'
import { tmp } from './helpers.ts'

const PKGBUILD = `pkgname=dopame
build() {
  cd "\${srcdir}/dopame"
  bun install --frozen-lockfile
  bun scripts/build.ts
  bun build backend/src/main.ts --target=bun --minify --outfile backend/dist/main.js
  bun build --compile "\${base}/empty.js" --outfile "\${base}/empty"
}

package() {
  cd "\${srcdir}/dopame"
  install -Dm644 packages/dopame/package.json -t "\${dir}"
  install -Dm755 "$(_target)/release/dopame-harness" -t "\${pkgdir}/usr/lib/dopame"
  install -Dm644 backend/dist/main.js -t "\${pkgdir}/usr/lib/dopame/backend"
  install -Dm644 backend/THIRD-PARTY-NOTICES.txt -t "\${pkgdir}/usr/lib/dopame/backend"
  install -Dm644 backend/extensions/*.ts -t "\${pkgdir}/usr/lib/dopame/backend/extensions"
}
`

function repo(pkgbuild: string): string {
  const dir = tmp()
  mkdirSync(join(dir, 'packaging', 'arch'), { recursive: true })
  writeFileSync(join(dir, 'packaging', 'arch', 'PKGBUILD'), pkgbuild)
  return dir
}

describe('acdev vm provision: the Dopame back end, as the dopame PKGBUILD builds and installs it', () => {
  test('the back end build in build() and the installs into /usr/lib/dopame/backend in package() are read; the rest is not', () => {
    expect(backendPlan(PKGBUILD)).toEqual({
      builds: [{ args: ['build', 'backend/src/main.ts', '--target=bun', '--minify', '--outfile', 'backend/dist/main.js'], output: 'backend/dist/main.js' }],
      installs: [
        { mode: '644', sources: ['backend/dist/main.js'], target: '/usr/lib/dopame/backend' },
        { mode: '644', sources: ['backend/THIRD-PARTY-NOTICES.txt'], target: '/usr/lib/dopame/backend' },
        { mode: '644', sources: ['backend/extensions/*.ts'], target: '/usr/lib/dopame/backend/extensions' },
      ],
    })
    const other = `build() {\n  bun scripts/build.ts\n}\npackage() {\n  install -Dm644 a -t "\${pkgdir}/usr/share/x"\n}\n`
    expect(backendPlan(other)).toEqual({ builds: [], installs: [] })
  })

  test('a PKGBUILD without a back end (an older dopame) stages nothing', () => {
    const dir = repo('build() {\n  bun scripts/build.ts\n}\n')
    expect(stageBackend(dir, tmp())).toBe(0)
    expect(stageBackend(tmp(), tmp())).toBe(0)
  })

  test('the build runs on the host into the stage; the files it installs are staged with their mode and place', () => {
    const dir = repo(PKGBUILD)
    mkdirSync(join(dir, 'backend', 'src'), { recursive: true })
    mkdirSync(join(dir, 'backend', 'extensions'), { recursive: true })
    writeFileSync(join(dir, 'backend', 'src', 'main.ts'), 'console.log("back end")\n')
    writeFileSync(join(dir, 'backend', 'THIRD-PARTY-NOTICES.txt'), 'notices')
    for (const name of ['b.ts', 'a.ts', 'c.md']) writeFileSync(join(dir, 'backend', 'extensions', name), name)
    const out = tmp()
    expect(stageBackend(dir, out)).toBe(4)
    expect(readFileSync(join(out, 'backend', 'backend', 'dist', 'main.js'), 'utf8')).toContain('back end')
    expect(existsSync(join(dir, 'backend', 'dist', 'main.js'))).toBe(false)
    expect(statSync(join(out, 'backend', 'backend', 'extensions', 'a.ts')).isFile()).toBe(true)
    expect(readFileSync(join(out, 'backend.install'), 'utf8')).toBe([
      '644\tbackend/backend/dist/main.js\t/usr/lib/dopame/backend',
      '644\tbackend/backend/THIRD-PARTY-NOTICES.txt\t/usr/lib/dopame/backend',
      '644\tbackend/backend/extensions/a.ts\t/usr/lib/dopame/backend/extensions',
      '644\tbackend/backend/extensions/b.ts\t/usr/lib/dopame/backend/extensions',
      '',
    ].join('\n'))
  })

  test('a file the PKGBUILD installs that is not there stops provision on the host, naming the path', () => {
    const dir = repo(`package() {\n  install -Dm644 backend/THIRD-PARTY-NOTICES.txt -t "\${pkgdir}/usr/lib/dopame/backend"\n}\n`)
    expect(() => stageBackend(dir, tmp())).toThrow(`${join(dir, 'backend', 'THIRD-PARTY-NOTICES.txt')} does not exist`)
    const globbed = repo(`package() {\n  install -Dm644 backend/extensions/*.ts -t "\${pkgdir}/usr/lib/dopame/backend/extensions"\n}\n`)
    expect(() => stageBackend(globbed, tmp())).toThrow('installs backend/extensions/*.ts')
  })

  test('the guest installs each staged file with its mode where the PKGBUILD puts it', () => {
    expect(PROVISION_SCRIPT).toContain(BACKEND_SCRIPT.join('\n'))
    expect(BACKEND_SCRIPT.join('\n')).toContain('install -Dm"$mode" "$here/dopame/$file" -t "$target"')
  })
})

describe('acdev vm provision: the systemd drop-ins the dopame PKGBUILD installs', () => {
  const DROPIN = `package() {
  install -Dm644 packaging/arch/dopame-board.service -t "\${pkgdir}/usr/lib/systemd/user"
  install -Dm644 packaging/arch/acdes-session-agent-dopame.conf \\
    "\${pkgdir}/usr/lib/systemd/system/acdes-session-agent@.service.d/dopame.conf"
  install -Dm644 "$x/a.conf" "\${pkgdir}/usr/lib/systemd/system/x.service.d/a.conf"
}
`

  test('only plain drop-ins into /usr/lib/systemd/system/<unit>.service.d are read, a continued line too', () => {
    expect(dropIns(DROPIN)).toEqual([
      { mode: '644', source: 'packaging/arch/acdes-session-agent-dopame.conf', target: '/usr/lib/systemd/system/acdes-session-agent@.service.d/dopame.conf' },
    ])
    expect(dropIns(PKGBUILD)).toEqual([])
  })

  test('each is staged and listed with its mode and file; a missing one stops provision on the host', () => {
    const dir = repo(DROPIN)
    expect(() => stageDropIns(dir, tmp())).toThrow('acdes-session-agent-dopame.conf does not exist')
    writeFileSync(join(dir, 'packaging', 'arch', 'acdes-session-agent-dopame.conf'), '[Service]\nExecStart=\n')
    const out = tmp()
    expect(stageDropIns(dir, out)).toBe(1)
    expect(readFileSync(join(out, 'units', '0', 'acdes-session-agent-dopame.conf'), 'utf8')).toContain('ExecStart=')
    expect(readFileSync(join(out, 'units.install'), 'utf8')).toBe(
      '644\tunits/0/acdes-session-agent-dopame.conf\t/usr/lib/systemd/system/acdes-session-agent@.service.d/dopame.conf\n',
    )
    expect(stageDropIns(repo(PKGBUILD), tmp())).toBe(0)
  })

  test('the guest installs them at their path and reloads systemd', () => {
    const script = DROPIN_SCRIPT.join('\n')
    expect(PROVISION_SCRIPT).toContain(script)
    expect(script).toContain('install -Dm"$mode" "$here/dopame/$file" "$target"')
    expect(script).toContain('systemctl daemon-reload')
  })
})
