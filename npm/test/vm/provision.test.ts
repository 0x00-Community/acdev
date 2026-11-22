import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, tmp } from '../helpers.ts'
import { PROVISION_SCRIPT, pkgbuildPaths, provisionOptions, provisionSources, stageProvision } from '../../src/vm/provision.ts'

afterAll(cleanup)

describe('acdev vm provision', () => {
  test('stages acdes for its own PKGBUILD, the Dopame package and the script', () => {
    const repo = tmp()
    mkdirSync(join(repo, 'acdes', 'packaging', 'arch'), { recursive: true })
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), 'package() { :; }\n')
    mkdirSync(join(repo, 'dopame', 'packages', 'dopame', 'dist'), { recursive: true })
    writeFileSync(join(repo, 'dopame', 'packages', 'dopame', 'package.json'), '{}')
    writeFileSync(join(repo, 'dopame', 'packages', 'dopame', 'dist', 'index.js'), '')
    for (const bin of ['acdes-bin', 'harness']) writeFileSync(join(repo, bin), bin)
    const sources = {
      acdes: join(repo, 'acdes'), acdesBin: join(repo, 'acdes-bin'), libacde: null,
      dopame: join(repo, 'dopame'), harness: join(repo, 'harness'),
    }
    const stage = stageProvision(sources)
    try {
      for (const file of ['provision.sh', 'acdes/PKGBUILD', 'acdes/src/target/release/acdes',
        'acdes/src/acdes/packaging/arch/PKGBUILD', 'acdes/src/libacde/LICENSE', 'dopame/package.json', 'dopame/dist/index.js',
        'dopame/dopame-harness']) {
        expect(existsSync(join(stage, file))).toBe(true)
      }
      expect(readFileSync(join(stage, 'provision.sh'), 'utf8')).toBe(PROVISION_SCRIPT)
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
    expect(() => stageProvision({ ...sources, acdesBin: null })).toThrow('--acdes needs --acdes-bin')
    expect(() => stageProvision({ ...sources, acdes: null })).toThrow('needs --acdes')
    const src = ['$', '{srcdir}/acdes'].join('')
    expect(pkgbuildPaths(`install -Dm644 "${src}/protocol/a/policy.json" x\ncp $srcdir/acdes/docs/*.md y\n`
      + `z "${src}/../etc/passwd" "${src}/protocol/a/policy.json"`)).toEqual(['protocol/a/policy.json', 'docs'])
    mkdirSync(join(repo, 'acdes', 'protocol'), { recursive: true })
    writeFileSync(join(repo, 'acdes', 'protocol', 'policy.json'), '{}')
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), `package() { install "${src}/protocol/policy.json"; }\n`)
    const used = stageProvision(sources)
    try {
      expect(existsSync(join(used, 'acdes/src/acdes/protocol/policy.json'))).toBe(true)
    } finally {
      rmSync(used, { recursive: true, force: true })
    }
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), `package() { install "${src}/docs/gone.md"; }\n`)
    expect(() => stageProvision(sources)).toThrow('docs/gone.md')
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), 'package() { install "$(_target)/release/system-agent"; }\n')
    expect(() => stageProvision(sources)).toThrow('give --system-agent-bin')
    writeFileSync(join(repo, 'system-agent'), 'system-agent')
    const withAgent = stageProvision({ ...sources, systemAgentBin: join(repo, 'system-agent') })
    try {
      expect(existsSync(join(withAgent, 'acdes/src/target/release/system-agent'))).toBe(true)
    } finally {
      rmSync(withAgent, { recursive: true, force: true })
    }
    const node = `install -Dm755 "$(_target)/release/libacdes_manager_node.so" "${['$', '{pkgdir}'].join('')}/usr/lib/acdes/manager.node"`
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), `package() { ${node}; }\n`)
    expect(() => stageProvision(sources)).toThrow('libacdes_manager_node.so: give --manager-node (cargo build -p acdes-manager-node)')
    writeFileSync(join(repo, 'manager.so'), 'node module')
    const withNode = stageProvision({ ...sources, managerNode: join(repo, 'manager.so') })
    try {
      expect(readFileSync(join(withNode, 'acdes/src/target/release/libacdes_manager_node.so'), 'utf8')).toBe('node module')
    } finally {
      rmSync(withNode, { recursive: true, force: true })
    }
    expect(provisionSources(new Map([['manager-node', '/m.so']])).managerNode).toBe('/m.so')
    writeFileSync(join(repo, 'acdes', 'packaging', 'arch', 'PKGBUILD'), 'package() { install -Dm755 "$(_target)/release/proxy" x; }\n')
    expect(() => stageProvision(sources)).toThrow('proxy: give --proxy-bin (cargo build -p acde-proxy)')
    writeFileSync(join(repo, 'proxy'), 'proxy')
    const withProxy = stageProvision({ ...sources, proxyBin: join(repo, 'proxy') })
    try {
      expect(readFileSync(join(withProxy, 'acdes/src/target/release/proxy'), 'utf8')).toBe('proxy')
    } finally {
      rmSync(withProxy, { recursive: true, force: true })
    }
    expect(provisionSources(new Map([['proxy-bin', '/p']])).proxyBin).toBe('/p')
  })

  test('the script lays out acdes by package(), sets the user and greetd, and takes the defaults it is told', () => {
    const lines = ['. "$here/acdes/PKGBUILD"', 'printf \'%s:%s\\n\' "$user" "$password" | chpasswd', 'command = "/usr/bin/acdes --greeter"', 'pacman -Sy',
      'for unit in acdes-system-agent acdes-proxy; do', 'rules=/etc/sudoers.d/acdev-dev', 'visudo -cf "$rules.tmp"']
    for (const line of lines) {
      expect(PROVISION_SCRIPT).toContain(line)
    }
    expect(provisionOptions(new Map(), {})).toEqual({ user: 'tester', password: 'dopame-dev', restart: true })
    expect(provisionOptions(new Map([['user', 'qa'], ['no-restart', '']]), { ACDEV_VM_PASSWORD: 'x' })).toEqual({ user: 'qa', password: 'x', restart: false })
  })
})
