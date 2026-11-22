import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { relayed } from '../../src/vm/channel.ts'
import { Devd } from '../../src/vm/devd.ts'
import { TOOL, crateBinary, crateVersion } from '../../src/vm/binary.ts'
import { accelArgs, bundledFirmware, findQemu, guestArch, guestDevices, missingFeatures, preferredAccel, qemuDirs } from '../../src/vm/host.ts'
import { defaultLink, Machine } from '../../src/vm/machine.ts'
import { displayOf } from '../../src/vm/command.ts'
import { audioOf, gpuArgs, hardwareArgs, resolutionOf, vgaOf } from '../../src/vm/hardware.ts'
import { Usb } from '../../src/vm/usb.ts'
import { cleanup, collect, env, tmp } from '../helpers.ts'
import { CLI } from './helpers.ts'

afterAll(cleanup)

describe('the QEMU command line', () => {
  test('KVM, virtio display, keyboard and tablet, the serial log, the share', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({ display: 'none', share: '/srv/out' }, 'kvm').join(' ')
    for (const part of ['-accel kvm', '-device virtio-vga', '-device virtio-keyboard-pci', '-device virtio-tablet-pci',
      '-display none', `path=${machine.serial}`, `vhost-vsock-pci,guest-cid=${machine.cid()}`, 'local,path=/srv/out,mount_tag=acdev', 'file=/c.fd']) {
      expect(args).toContain(part)
    }
    expect(machine.args({}, 'tcg').join(' ')).toContain('-accel tcg,thread=multi -cpu max -smp')
    expect(machine.args({ gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0 -display gtk,gl=on')
    expect(args).toContain(`-fw_cfg name=opt/acdev/key,file=${machine.key}`)
    expect(args).toContain('-serial chardev:serial0 -parallel none')
    expect(args).toContain('-qmp unix:')
  })

  test('vm screenshot under --gl says why it cannot and what to use instead', async () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    mkdirSync(join(machine.dir, 'run'), { recursive: true })
    writeFileSync(join(machine.dir, 'run', 'qemu.pid'), `${process.pid}\n`)
    writeFileSync(join(machine.dir, 'run', 'gl'), 'on\n')
    expect(machine.gl()).toBe(true)
    await expect(machine.screenshot(join(tmp(), 'shot.png'))).rejects.toThrow('acdev screen --session vm -o FILE.png')
  })

  test('QEMU starts with its window shown (windowsHide off) unless it has none: --headless, --vnc, --viewer', () => {
    expect([undefined, 'window', 'sdl', 'gtk'].map((d) => Machine.windowed(d as never))).toEqual([true, true, true, true])
    expect(['none', 'vnc', 'viewer'].map((d) => Machine.windowed(d as never))).toEqual([false, false, false])
  })

  test('--sdl gives QEMU its SDL window (with GL when --gl), alone and on Linux only; --gtk the GTK one', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, { platform: 'linux', arch: 'x64' })
    expect(machine.args({ display: 'sdl' }, 'kvm').join(' ')).toContain('-device virtio-vga,id=gpu0 -display sdl')
    expect(machine.args({ display: 'sdl', gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0 -display sdl,gl=on')
    expect(machine.args({}, 'kvm').join(' ')).toContain('-display gtk')
    expect(() => machine.refuse({ display: 'sdl', gl: true })).not.toThrow()
    const mac = new Machine({ ACDEV_VM_DIR: tmp(), ACDEV_VM_ARCH: 'aarch64' }, { platform: 'darwin', arch: 'arm64' })
    expect(() => mac.refuse({ display: 'sdl' })).toThrow('--sdl (QEMU\'s SDL window) is Linux only')
    expect(() => mac.refuse({ display: 'gtk' })).toThrow('--gtk is for Linux')
    expect(machine.args({ display: 'gtk', gl: true }, 'kvm').join(' ')).toContain('-display gtk,gl=on')
    expect(displayOf(new Map([['gtk', '']]))).toBe('gtk')
    expect(displayOf(new Map([['sdl', '']]))).toBe('sdl')
    expect(displayOf(new Map())).toBe('window')
    expect(() => displayOf(new Map([['sdl', ''], ['viewer', '']]))).toThrow('one of --headless, --vnc, --viewer, --sdl, --gtk, not --viewer and --sdl')
  })

  test('on Linux the default window is SDL when QEMU has it, else GTK with a note; other hosts keep their window', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, { platform: 'linux', arch: 'x64' })
    const said: string[] = []
    const say = (line: string) => void said.push(line)
    expect(machine.window('window', ['none', 'gtk', 'sdl', 'dbus'], say)).toBe('sdl')
    expect(machine.window('gtk', ['gtk', 'sdl'], say)).toBe('gtk')
    expect(said).toEqual([])
    expect(machine.window('window', ['none', 'gtk', 'dbus'], say)).toBe('gtk')
    expect(said[0]).toContain('this QEMU has no SDL display')
    expect(() => machine.window('sdl', ['gtk'], say)).toThrow('--sdl: this QEMU has no SDL display')
    const mac = new Machine({ ACDEV_VM_DIR: tmp(), ACDEV_VM_ARCH: 'aarch64' }, { platform: 'darwin', arch: 'arm64' })
    expect(mac.window('window', [], say)).toBe('window')
  })

  test('the displays a QEMU has come from -display help', () => {
    const fake = join(tmp(), 'qemu-system-x86_64')
    writeFileSync(fake, '#!/bin/sh\nprintf "Available display backend types:\\nnone\\ngtk\\nsdl\\negl-headless\\n"\n', { mode: 0o755 })
    expect(Machine.displays(fake)).toEqual(['none', 'gtk', 'sdl', 'egl-headless'])
  })

  test('--viewer gives QEMU a peer-to-peer D-Bus display; acdevtool comes from ACDEVTOOL', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    expect(machine.args({ display: 'viewer' }, 'kvm').join(' ')).toContain('-display dbus,p2p=yes')
    expect(crateBinary(Machine.ROOT, TOOL, { ACDEVTOOL: CLI })).toBe(CLI)
    expect(() => crateBinary(Machine.ROOT, TOOL, { ACDEVTOOL: '/no/such/tool' })).toThrow('ACDEVTOOL=/no/such/tool: no such file')
  })

  test('--outputs N gives the display device N heads; one is the default', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const one = machine.args({}, 'kvm').join(' ')
    expect(one).toContain('-device virtio-vga,id=gpu0 ')
    expect(one).not.toContain('max_outputs')
    expect(machine.args({ outputs: 2 }, 'kvm').join(' ')).toContain('-device virtio-vga,id=gpu0,max_outputs=2 ')
    expect(machine.args({ outputs: 3, gl: true }, 'kvm').join(' ')).toContain('-device virtio-vga-gl,id=gpu0,max_outputs=3 ')
    expect(machine.args({ display: 'none' }, 'kvm').join(' ')).toContain('-display none')
    expect(machine.args({ display: 'none', outputs: 2 }, 'kvm').join(' ')).toContain('-display dbus,p2p=yes')
  })

  test('two PCIe root ports, rp1 and rp2, take hot-plugged devices', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({}, 'kvm').join(' ')
    expect(args).toContain('-device pcie-root-port,id=rp1,bus=pcie.0,chassis=11,slot=11')
    expect(args).toContain('-device pcie-root-port,id=rp2,bus=pcie.0,chassis=12,slot=12')
  })

  test('acdevd: ACDEV_DEVD, then CARGO_TARGET_DIR, then logs/cargo-target/acdev-devd above, then the crate\'s target', () => {
    const base = tmp()
    const root = join(base, 'repo', 'npm')
    const wanted = { crate: 'devd', name: 'acdevd', variable: 'ACDEV_DEVD', shared: 'acdev-devd' }
    const place = (dir: string) => {
      mkdirSync(join(dir, 'release'), { recursive: true })
      writeFileSync(join(dir, 'release', 'acdevd'), '')
      return join(dir, 'release', 'acdevd')
    }
    const own = place(join(base, 'repo', 'crates', 'devd', 'target'))
    expect(crateBinary(root, wanted, {})).toBe(own)
    const shared = place(join(base, 'logs', 'cargo-target', 'acdev-devd'))
    expect(crateBinary(root, wanted, {})).toBe(shared)
    const configured = place(join(base, 'elsewhere'))
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere') })).toBe(configured)
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere'), ACDEV_DEVD: own })).toBe(own)
  })

  test('an install\'s libexec comes right after the variable: acdevd-<guest arch>, acdevtool', () => {
    const base = tmp()
    const root = join(base, 'repo', 'npm')
    const libexec = join(base, 'install', 'libexec')
    mkdirSync(libexec, { recursive: true })
    for (const name of ['acdevd-aarch64', 'acdevtool']) writeFileSync(join(libexec, name), '')
    const beside = (name: string) => join(libexec, name)
    const devd = { crate: 'devd', name: 'acdevd', variable: 'ACDEV_DEVD', installed: Devd.shipped('aarch64') }
    expect(Devd.shipped('x86_64')).toBe('acdevd-x86_64')
    expect(crateBinary(root, devd, {}, beside)).toBe(join(libexec, 'acdevd-aarch64'))
    expect(crateBinary(root, devd, { ACDEV_DEVD: CLI }, beside)).toBe(CLI)
    expect(crateBinary(root, TOOL, {}, beside)).toBe(join(libexec, 'acdevtool'))
    rmSync(join(libexec, 'acdevtool'))
    expect(() => crateBinary(root, TOOL, {}, beside)).toThrow('vm: no acdevtool')
  })

  test('an acdevd of another version is refused before it goes into the guest', () => {
    const dir = tmp()
    const fake = (version: string) => {
      const path = join(dir, `acdevd-${version}`)
      writeFileSync(path, `#!/bin/sh\necho "acdevd ${version}"\n`, { mode: 0o755 })
      return path
    }
    const want = crateVersion(Machine.ROOT, 'devd')!
    expect(() => Devd.checkVersion(fake(want), Machine.ROOT)).not.toThrow()
    expect(() => Devd.checkVersion(fake('0.1.0'), Machine.ROOT)).toThrow(`is acdevd 0.1.0, this acdev needs ${want}. Rebuild it: cd `)
    expect(() => Devd.checkVersion(fake('0.1.0'), Machine.ROOT)).toThrow(`or set ACDEV_DEVD to an acdevd ${want} binary`)
  })

  test('a start that fails after QEMU is up stops that QEMU', async () => {
    const dir = tmp()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    script('qemu-system-x86_64', 'while [ $# -gt 0 ]; do [ "$1" = -pidfile ] && echo $$ > "$2"; shift; done; exec sleep 60')
    script('qemu-img', 'exit 0')
    writeFileSync(join(dir, 'image.qcow2'), '')
    const vm = join(dir, 'vm')
    const started = await collect([process.execPath, CLI, 'vm', 'start', '--viewer', '--wait', '0', '--image', join(dir, 'image.qcow2')], {
      cwd: dir,
      env: env({ ACDEV_VM_DIR: vm, ACDEVTOOL: join(dir, 'no-tool'), PATH: `${bin}:${process.env['PATH']}`,
        OVMF_CODE: join(dir, 'image.qcow2'), OVMF_VARS: join(dir, 'image.qcow2') }),
    })
    expect(started.code, started.out).toBe(1)
    expect(started.stderr).toContain('ACDEVTOOL=')
    expect(started.stderr).toMatch(/stopped qemu \(pid (\d+)\): the start did not finish/)
    const pid = Number(/stopped qemu \(pid (\d+)\)/.exec(started.stderr)![1])
    await new Promise((done) => setTimeout(done, 200))
    expect(() => process.kill(pid, 0)).toThrow()
    expect(existsSync(join(vm, 'run', 'qemu.pid'))).toBe(false)
  }, 60_000)

  test('start checks acdevd\'s version before it starts QEMU', async () => {
    const dir = tmp()
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const script = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    script('qemu-system-x86_64', `touch ${join(dir, 'qemu-ran')}`)
    script('qemu-img', 'exit 0')
    script('acdevd-old', 'echo "acdevd 0.0.1"')
    writeFileSync(join(dir, 'image.qcow2'), '')
    const started = await collect([process.execPath, CLI, 'vm', 'start', '--headless', '--image', join(dir, 'image.qcow2')], {
      cwd: dir,
      env: env({ ACDEV_VM_DIR: join(dir, 'vm'), ACDEV_DEVD: join(bin, 'acdevd-old'), PATH: `${bin}:${process.env['PATH']}`,
        OVMF_CODE: join(dir, 'image.qcow2'), OVMF_VARS: join(dir, 'image.qcow2') }),
    })
    expect(started.code).toBe(1)
    expect(started.stderr).toContain('is acdevd 0.0.1, this acdev needs')
    expect(existsSync(join(dir, 'qemu-ran'))).toBe(false)
  })

  test('a forwarded link replaces vsock with a hostfwd to acdevd\'s port', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const unix = machine.args({}, 'kvm', { kind: 'unix', path: '/r/devd.sock' }).join(' ')
    expect(unix).toContain('user,model=virtio-net-pci,hostfwd=unix:/r/devd.sock-:5252')
    expect(unix).not.toContain('vhost-vsock')
    expect(machine.args({}, 'kvm', { kind: 'tcp', port: 4321 }).join(' ')).toContain(',hostfwd=tcp:127.0.0.1:4321-:5252')
    expect(new Machine({ ACDEV_VM_TRANSPORT: 'unix' }).linkKind()).toBe('unix')
    expect(['linux', 'darwin', 'win32', 'freebsd'].map((p) => defaultLink(p as NodeJS.Platform))).toEqual(['vsock', 'tcp', 'tcp', 'tcp'])
    expect(() => new Machine({ ACDEV_VM_TRANSPORT: 'usb' }).linkKind()).toThrow('vsock, unix, tcp')
  })

  test('acdev vm: an unknown subcommand, and stop or status with no guest', async () => {
    const dir = tmp()
    const run = (args: string[]) => collect([process.execPath, CLI, 'vm', ...args], { cwd: dir, env: env({ ACDEV_VM_DIR: dir }) })
    const unknown = await run(['bogus'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('unknown subcommand "bogus": fetch, start, stop')
    expect((await run(['stop'])).stderr).toBe('acdev vm: not running\n')
    expect((await run(['status'])).stdout).toContain('guest: not running')
    expect((await run(['run', 'true'])).stderr).toContain(`no guest is running from ${dir}`)
    expect((await run(['view'])).stderr).toContain(`no guest is running from ${dir}`)
    expect((await run(['start', '--outputs', '0'])).stderr).toContain('--outputs 0: a whole number from 1 to 16')
    expect((await run(['start', '--outputs', '2.5'])).stderr).toContain('--outputs 2.5: a whole number from 1 to 16')
    expect((await run(['start', '--outputs', '2', '--viewer'])).stderr).toContain('--viewer shows only the first output')
    expect((await run(['screenshot', 'x.png', '--output', '1.5'])).stderr).toContain('--output 1.5: a whole number from 0 to 15')
    expect((await run(['start', '--headless', '--viewer'])).stderr).toContain('one of --headless, --vnc, --viewer, --sdl, --gtk, not --headless and --viewer')
  })
})

describe('hosts other than Linux (only the parts that run here)', () => {
  const windows = { platform: 'win32', arch: 'x64' } as const
  const mac = { platform: 'darwin', arch: 'x64' } as const

  test('the accelerator: KVM when /dev/kvm opens, WHPX on Windows, HVF on macOS, else TCG; WHPX takes -cpu max', () => {
    expect(preferredAccel({ platform: 'linux', arch: 'x64' }, true)).toBe('kvm')
    expect(preferredAccel({ platform: 'linux', arch: 'x64' }, false)).toBe('tcg')
    expect(preferredAccel(windows, false)).toBe('whpx')
    expect(preferredAccel(mac, false)).toBe('hvf')
    expect(accelArgs('whpx')).toEqual(['-accel', 'whpx', '-cpu', 'max'])
    expect(accelArgs('hvf')).toEqual(['-accel', 'hvf', '-cpu', 'host'])
    expect(accelArgs('tcg')).toEqual(['-accel', 'tcg,thread=multi', '-cpu', 'max'])
  })

  test('QEMU on Windows: ACDEV_QEMU_DIR, PATH, the registry, Program Files, MSYS2, in that order', () => {
    const env = { PATH: 'C:\\tools;C:\\bin', ProgramFiles: 'D:\\Programs' }
    expect(qemuDirs({ host: windows, env, registry: () => 'E:\\qemu' }))
      .toEqual(['C:\\tools', 'C:\\bin', 'E:\\qemu', 'D:\\Programs\\qemu', 'C:\\msys64\\ucrt64\\bin', 'C:\\msys64\\mingw64\\bin'])
    const there = new Set(['D:\\Programs\\qemu\\qemu-system-x86_64.exe', 'D:\\Programs\\qemu\\qemu-img.exe'])
    const qemu = findQemu({ host: windows, env, registry: () => null, exists: (path) => there.has(path) }, 'x86_64')
    expect(qemu).toEqual({ system: 'D:\\Programs\\qemu\\qemu-system-x86_64.exe', img: 'D:\\Programs\\qemu\\qemu-img.exe' })
    expect(bundledFirmware(windows, qemu, 'x86_64'))
      .toEqual(['D:\\Programs\\qemu\\share\\edk2-x86_64-code.fd', 'D:\\Programs\\qemu\\share\\edk2-i386-vars.fd'])
    const given = qemuDirs({ host: windows, env: { ...env, ACDEV_QEMU_DIR: 'F:\\q' }, registry: () => null })
    expect(given[0]).toBe('F:\\q')
    expect(() => findQemu({ host: windows, env, registry: () => null, exists: () => false }, 'x86_64')).toThrow('qemu.weilnetz.de')
  })

  test('QEMU on macOS: PATH, then Homebrew on Apple silicon and Intel, then MacPorts; its share/qemu firmware', () => {
    expect(qemuDirs({ host: mac, env: { PATH: '/usr/bin' } })).toEqual(['/usr/bin', '/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'])
    expect(bundledFirmware(mac, { system: '/usr/local/bin/qemu-system-x86_64', img: '/usr/local/bin/qemu-img' }, 'x86_64'))
      .toEqual(['/usr/local/share/qemu/edk2-x86_64-code.fd', '/usr/local/share/qemu/edk2-i386-vars.fd'])
  })

  test('on Windows QMP and the guest agent are Unix sockets in run/ too; --share and the viewer are refused', async () => {
    const dir = tmp()
    const temp = tmp()
    const machine = new Machine({ ACDEV_VM_DIR: dir, TEMP: temp, OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, windows)
    const args = machine.args({}, 'whpx', { kind: 'tcp', port: 4003 }).join(' ')
    expect(dirname(machine.qmp)).toMatch(/[\\/]acdev-[0-9a-f]{12}$/)
    expect(machine.qmp.startsWith(temp)).toBe(true)
    expect(machine.accelerator()).toBe('WHPX (the Windows Hypervisor Platform feature); TCG if it does not start')
    expect(args).toContain('-accel whpx -cpu max')
    expect(args).toContain(`-qmp unix:${machine.qmp},server=on,wait=off`)
    expect(args).toContain(`-chardev socket,path=${machine.qga},server=on,wait=off,id=qga0`)
    expect(args).toContain('hostfwd=tcp:127.0.0.1:4003-:5252')
    expect(machine.linkKind()).toBe('tcp')
    await expect(machine.start({ share: 'C:\\src' }, () => undefined)).rejects.toThrow('use acdev vm push')
    await expect(machine.start({ display: 'viewer' }, () => undefined)).rejects.toThrow('Linux only for now')
    expect(() => machine.devdBinary()).toThrow('no acdevd for the guest (Linux x86_64)')
  })

  test('acdevtool relay: ACDEVTOOL, then CARGO_TARGET_DIR, then the crate\'s target; its failure ends the stream, not acdev', async () => {
    const base = tmp()
    const root = join(base, 'repo', 'npm')
    const wanted = TOOL
    const place = (dir: string) => {
      mkdirSync(join(dir, 'release'), { recursive: true })
      writeFileSync(join(dir, 'release', 'acdevtool'), '')
      return join(dir, 'release', 'acdevtool')
    }
    const own = place(join(base, 'repo', 'crates', 'tool', 'target'))
    expect(crateBinary(root, wanted, {})).toBe(own)
    const configured = place(join(base, 'elsewhere'))
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere') })).toBe(configured)
    expect(crateBinary(root, wanted, { CARGO_TARGET_DIR: join(base, 'elsewhere'), ACDEVTOOL: own })).toBe(own)
    const failing = join(base, 'failing-relay')
    writeFileSync(failing, '#!/bin/sh\n[ "$1" = relay ] && echo "acdevtool relay: $2: connection refused" >&2\nexit 1\n', { mode: 0o755 })
    const stream = relayed('/no/such.sock', { ACDEVTOOL: failing })
    const error = await new Promise<Error>((done) => stream.once('error', done))
    expect(error.message).toBe('acdevtool relay: /no/such.sock: connection refused')
  })

  test('on an Intel Mac: HVF with the host CPU, QEMU\'s Cocoa window, a forwarded TCP port; Apple silicon refuses an x86_64 guest', async () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, mac)
    const args = machine.args({}, 'hvf', { kind: 'tcp', port: 4005 }).join(' ')
    expect(args).toContain('-machine q35 -accel hvf -cpu host')
    expect(args).toContain('-display cocoa')
    expect(args).toContain('-qmp unix:')
    expect(args).not.toContain('vhost-vsock')
    expect(machine.linkKind()).toBe('tcp')
    const silicon = new Machine({ ACDEV_VM_DIR: tmp(), ACDEV_VM_ARCH: 'x86_64' }, { platform: 'darwin', arch: 'arm64' })
    await expect(silicon.start({}, () => undefined)).rejects.toThrow('runs only an aarch64 guest')
  })

  test('aarch64 guests: on arm64 hosts or ACDEV_VM_ARCH; virt, the GIC, virtio-gpu-pci, PL011', () => {
    expect(guestArch({ platform: 'darwin', arch: 'arm64' })).toBe('aarch64')
    expect(guestArch({ platform: 'linux', arch: 'x64' })).toBe('x86_64')
    expect(guestArch({ platform: 'linux', arch: 'x64' }, { ACDEV_VM_ARCH: 'aarch64' })).toBe('aarch64')
    expect(() => guestArch({ platform: 'linux', arch: 'x64' }, { ACDEV_VM_ARCH: 'riscv64' })).toThrow('x86_64 or aarch64')
    expect(guestDevices('aarch64', 'kvm').machine).toBe('virt,gic-version=host')
    expect(guestDevices('aarch64', 'hvf')).toEqual({
      machine: 'virt,gic-version=max', gpu: 'virtio-gpu-pci', gpuGl: 'virtio-gpu-gl-pci', gpuStd: 'bochs-display', console: 'ttyAMA0',
    })
    expect(accelArgs('whpx', 'aarch64')).toEqual(['-accel', 'whpx', '-cpu', 'host'])
    const silicon = { platform: 'darwin', arch: 'arm64' } as const
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/a.fd', OVMF_VARS: '/b.fd' }, silicon)
    const args = machine.args({ outputs: 2 }, 'hvf', { kind: 'tcp', port: 4006 }).join(' ')
    expect(args).toContain('-machine virt,gic-version=max -accel hvf -cpu host')
    expect(args).toContain('-device virtio-gpu-pci,id=gpu0,max_outputs=2 ')
    expect(args).toContain('-fw_cfg name=opt/acdev/key')
    expect(args).not.toContain('virtio-vga')
    expect(bundledFirmware(silicon, { system: '/opt/homebrew/bin/qemu-system-aarch64', img: '/opt/homebrew/bin/qemu-img' }, 'aarch64'))
      .toEqual(['/opt/homebrew/share/qemu/edk2-aarch64-code.fd', '/opt/homebrew/share/qemu/edk2-arm-vars.fd'])
    expect(Machine.latestName('aarch64')).toBe('latest-qcow2-aarch64')
    expect(Machine.latestName('x86_64')).toBe('latest-qcow2')
    expect(Machine.DIST).toBe('https://pkgs.dopame.ai/iso')
  })

  test('the guest CPU must have the x86-64-v3 features', () => {
    const flags = 'flags\t\t: fpu sse4_2 avx avx2 bmi1 bmi2 f16c fma abm movbe xsave\n'
    expect(missingFeatures(flags)).toEqual([])
    expect(missingFeatures('flags\t: fpu sse4_2 avx xsave\n')).toEqual(['avx2', 'bmi1', 'bmi2', 'f16c', 'fma', 'abm', 'movbe'])
  })
})

describe('emulated hardware', () => {
  test('--vga std is the standard VGA at a fixed size; virtio keeps its heads and takes a size only when given', () => {
    const x86 = guestDevices('x86_64', 'kvm')
    const choice = { vga: 'virtio' as const, gl: false, outputs: 1, resolution: null }
    expect(gpuArgs(x86, 'gpu0', choice)).toEqual(['-device', 'virtio-vga,id=gpu0'])
    expect(gpuArgs(x86, 'gpu0', { ...choice, outputs: 2, resolution: [1920, 1080] }))
      .toEqual(['-device', 'virtio-vga,id=gpu0,max_outputs=2,xres=1920,yres=1080'])
    expect(gpuArgs(x86, 'gpu0', { ...choice, vga: 'std' })).toEqual(['-device', 'VGA,id=gpu0,xres=1280,yres=800'])
    expect(gpuArgs(guestDevices('aarch64', 'kvm'), 'gpu0', { ...choice, vga: 'std', resolution: [1024, 768] }))
      .toEqual(['-device', 'bochs-display,id=gpu0,xres=1024,yres=768'])
    expect([vgaOf(undefined), vgaOf('std'), resolutionOf('1600x900'), resolutionOf(undefined)]).toEqual(['virtio', 'std', [1600, 900], null])
    expect(() => vgaOf('cirrus')).toThrow('--vga cirrus: one of virtio, std')
    expect(() => resolutionOf('big')).toThrow('--resolution big')
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, { platform: 'linux', arch: 'x64' })
    expect(machine.args({ display: 'none', vga: 'std' }, 'kvm').join(' ')).toContain('-device VGA,id=gpu0,xres=1280,yres=800 -display none')
    expect(() => machine.refuse({ vga: 'std', gl: true })).not.toThrow()
    expect(() => machine.refuse({ vga: 'std', outputs: 2 })).toThrow('--vga std has one display')
  })

  test('a sound card with a silent or wav backend, an xHCI controller and S3 on x86_64', () => {
    expect(hardwareArgs('x86_64', 'none', '/l')).toEqual([
      '-audiodev', 'none,id=snd0', '-device', 'ich9-intel-hda,id=sound0', '-device', 'hda-duplex,bus=sound0.0,audiodev=snd0',
      '-device', 'qemu-xhci,id=xhci', '-global', 'ICH9-LPC.disable_s3=0',
    ])
    expect(hardwareArgs('aarch64', 'wav', '/l')).toEqual([
      '-audiodev', 'wav,id=snd0,path=/l/audio.wav', '-device', 'ich9-intel-hda,id=sound0', '-device', 'hda-duplex,bus=sound0.0,audiodev=snd0',
      '-device', 'qemu-xhci,id=xhci',
    ])
    expect(audioOf(undefined)).toBe('none')
    expect(() => audioOf('pa')).toThrow('--audio pa: one of none, wav')
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' })
    const args = machine.args({ display: 'none', audio: 'wav' }, 'kvm').join(' ')
    expect(args).toContain(`-audiodev wav,id=snd0,path=${join(machine.logs, 'audio.wav')}`)
    expect(args).toContain('-device qemu-xhci,id=xhci -global ICH9-LPC.disable_s3=0')
  })

  test('usb add plugs an image in over QMP and remove pulls it, waiting until the guest lets go', async () => {
    const run = tmp()
    const image = join(tmp(), 'stick.img')
    writeFileSync(image, 'x')
    const sent: [string, unknown][] = []
    let busy = 1
    const qmp = async (command: string, args?: unknown) => {
      sent.push([command, args])
      if (command === 'blockdev-del' && busy-- > 0) throw new Error('Node usb0-disk is in use')
      return {}
    }
    const usb = new Usb(run, qmp)
    expect(await usb.add(image, Usb.SIZE, null)).toEqual({ id: 'usb0', image })
    expect(sent.slice(0, 2)).toEqual([
      ['blockdev-add', { 'node-name': 'usb0-disk', driver: 'raw', file: { driver: 'file', filename: image } }],
      ['device_add', { driver: 'usb-storage', bus: 'xhci.0', drive: 'usb0-disk', id: 'usb0', removable: true }],
    ])
    await expect(usb.add(image, Usb.SIZE, null)).rejects.toThrow('is already plugged in')
    expect(await usb.remove(undefined, async () => undefined)).toEqual({ id: 'usb0', image })
    expect(sent.slice(2).map(([command]) => command)).toEqual(['device_del', 'blockdev-del', 'blockdev-del'])
    expect(usb.list()).toEqual([])
    await expect(usb.remove('usb3')).rejects.toThrow('no USB stick usb3 (plugged: none)')
  })

  test('a new image needs mkfs.vfat or mkfs.exfat, and sizes read like 256M', async () => {
    const usb = new Usb(tmp(), async () => ({}))
    await expect(usb.add(join(tmp(), 'new.img'), Usb.SIZE, null)).rejects.toThrow('install dosfstools (mkfs.vfat) or exfatprogs (mkfs.exfat)')
    expect([Usb.size(undefined), Usb.size('2G'), Usb.size('512m')]).toEqual([256 * 1024 ** 2, 2 * 1024 ** 3, 512 * 1024 ** 2])
    expect(() => Usb.size('lots')).toThrow('--size lots')
    const bin = tmp()
    writeFileSync(join(bin, 'mkfs.exfat'), '#!/bin/sh\n', { mode: 0o755 })
    expect(Usb.formatter([bin])?.tool).toBe(join(bin, 'mkfs.exfat'))
    expect(Usb.searched(`${bin}:/opt/bin`)).toEqual([bin, '/opt/bin', '/usr/sbin', '/sbin'])
  })

  test('more than one display with a window takes GTK; --sdl refuses it', () => {
    const machine = new Machine({ ACDEV_VM_DIR: tmp(), OVMF_CODE: '/c.fd', OVMF_VARS: '/v.fd' }, { platform: 'linux', arch: 'x64' })
    const said: string[] = []
    expect(machine.window('window', ['gtk', 'sdl'], (line) => void said.push(line), 2)).toBe('gtk')
    expect(said[0]).toContain('--outputs 2: the window is GTK')
    expect(() => machine.window('sdl', ['gtk', 'sdl'], () => undefined, 2)).toThrow('--sdl with --outputs 2')
    expect(machine.window('none', ['sdl'], () => undefined, 2)).toBe('none')
    expect(machine.args({ display: 'gtk', outputs: 2 }, 'kvm').join(' ')).toContain('virtio-vga,id=gpu0,max_outputs=2 -display gtk')
  })
})
