#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

const DIST = (process.env.ACDEV_DIST || 'https://pkgs.dopame.ai/acdev').replace(/\/+$/, '')
const WINDOWS = process.platform === 'win32'
const NAMES = WINDOWS ? ['acdev.cmd', 'acdev.exe', 'acdev.bat'] : ['acdev']
const DECLINED = 3

class Acdev {
  static installDir() {
    return process.env.ACDEV_INSTALL || join(homedir(), '.acdev')
  }

  static installer() {
    return WINDOWS
      ? { show: `irm ${DIST}/install.ps1 | iex`, exe: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${DIST}/install.ps1 | iex`] }
      : { show: `curl -fsSL ${DIST}/install.sh | sh`, exe: 'sh', args: ['-c', `curl -fsSL ${DIST}/install.sh | sh`] }
  }

  static find() {
    const dirs = [...(process.env.PATH || '').split(delimiter).filter(Boolean), join(Acdev.installDir(), 'bin')]
    for (const dir of dirs) {
      for (const name of NAMES) {
        const file = join(dir, name)
        if (existsSync(file) && statSync(file).isFile()) return file
      }
    }
    return undefined
  }

  static run(exe, args) {
    return new Promise((resolve) => {
      const child = spawn(exe, args, { stdio: 'inherit', shell: WINDOWS && /\.(cmd|bat)$/i.test(exe) })
      const forward = (signal) => () => child.kill(signal)
      const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((signal) => [signal, forward(signal)])
      if (!WINDOWS) for (const [signal, handler] of handlers) process.on(signal, handler)
      child.on('error', (error) => {
        process.stderr.write(`create-acde: could not run ${exe}: ${error.message}\n`)
        resolve(1)
      })
      child.on('exit', (code, signal) => {
        for (const [name, handler] of handlers) process.off(name, handler)
        resolve(code ?? (signal === 'SIGINT' ? DECLINED : 1))
      })
    })
  }

  static async ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = (await rl.question(question)).trim().toLowerCase()
      return answer === '' || answer === 'y' || answer === 'yes'
    } catch {
      return false
    } finally {
      rl.close()
    }
  }

  static async install(args) {
    const installer = Acdev.installer()
    const interactive = process.stdin.isTTY && process.stdout.isTTY && !args.includes('--yes') && !args.includes('-y')
    if (!interactive) {
      process.stderr.write(`create-acde: acdev is not installed. Install it first, then run this again:\n  ${installer.show}\n`)
      return undefined
    }
    process.stdout.write(`acdev is not installed. It makes the project and runs it on Dopame OS.\nThe installer is: ${installer.show}\n`)
    if (!(await Acdev.ask('Install acdev now? (Y/n) '))) {
      process.stderr.write(`create-acde: nothing was made. Install acdev with the command above, then run this again.\n`)
      return undefined
    }
    const code = await Acdev.run(installer.exe, installer.args)
    if (code !== 0) {
      process.stderr.write(`create-acde: the acdev installer failed (exit code ${code}); nothing was made.\n`)
      return undefined
    }
    return Acdev.find()
  }
}

const args = process.argv.slice(2)
const acdev = Acdev.find() ?? (await Acdev.install(args))
process.exit(acdev ? await Acdev.run(acdev, ['new', ...args]) : 1)
