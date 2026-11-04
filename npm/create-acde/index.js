#!/usr/bin/env node
// npm create acde [dir] [-- --type app|desktop --id ID --label NAME --no-install --no-git]
// A new acde project: the template (acde-app's), `acde` and `@dopame/acde-api` as devDependencies, npm scripts
// (dev / build / check / install), the dependencies installed with the package manager that ran it, a git repository.
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERSION = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
const TYPES = ['app', 'desktop']
const color = (code) => (text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text)
const bold = color('1'), dim = color('2'), green = color('32'), red = color('31'), cyan = color('36')

function parse(argv) {
  const out = { dir: null, type: null, id: null, label: null, install: true, git: true, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      const v = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[++i]
      if (v === undefined) throw new Error(`${arg} needs a value`)
      return v
    }
    if (arg === '--no-install') out.install = false
    else if (arg === '--no-git') out.git = false
    else if (arg === '-y' || arg === '--yes') out.yes = true
    else if (arg === '--desktop') out.type = 'desktop'
    else if (arg.startsWith('--type')) out.type = value()
    else if (arg.startsWith('--id')) out.id = value()
    else if (arg.startsWith('--label')) out.label = value()
    else if (arg === '-h' || arg === '--help') out.help = true
    else if (arg.startsWith('-')) throw new Error(`unknown option ${arg}`)
    else if (out.dir === null) out.dir = arg
    else throw new Error(`one directory only (${out.dir}, ${arg})`)
  }
  if (out.type !== null && !TYPES.includes(out.type)) throw new Error(`--type is app or desktop, not ${out.type}`)
  return out
}

const HELP = `${bold('npm create acde')} [dir] -- [options]

  --type app|desktop   an app (a web page in its own window; default) or a desktop (the whole screen)
  --desktop            the same as --type desktop
  --id ID              the app's id (lowercase letters, digits and -; default: the directory's name)
  --label NAME         the name shown for it (default: the id)
  --no-install         do not install the dependencies
  --no-git             do not start a git repository
  -y, --yes            take the defaults, ask nothing`

async function ask(options) {
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !options.yes
  if (!interactive) return { ...options, dir: options.dir ?? 'my-acde-app', type: options.type ?? 'app' }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const dir = options.dir ?? ((await rl.question(`${cyan('?')} ${bold('Where should the project go?')} ${dim('(my-acde-app)')} `)).trim() || 'my-acde-app')
    let type = options.type
    while (!type) {
      const answer = (await rl.question(`${cyan('?')} ${bold('What is it?')} ${dim('1) an app, a window of its own  2) a desktop, the whole screen')} ${dim('(1)')} `)).trim()
      type = answer === '' || answer === '1' || answer === 'app' ? 'app' : answer === '2' || answer === 'desktop' ? 'desktop' : null
    }
    return { ...options, dir, type }
  } finally {
    rl.close()
  }
}

/** What the dependencies are: the published versions, or local tarballs (CREATE_ACDE_LOCAL=<dir of .tgz>) for trying it out. */
function dependency(name) {
  const local = process.env.CREATE_ACDE_LOCAL
  if (!local) return `^${VERSION}`
  const file = readdirSync(local).find((f) => f.startsWith(`${name.replace('@', '').replace('/', '-')}-`) && f.endsWith('.tgz'))
  if (!file) throw new Error(`CREATE_ACDE_LOCAL: no ${name} tarball in ${local}`)
  return `file:${resolve(local, file)}`
}

function packageManager() {
  const agent = process.env.npm_config_user_agent ?? ''
  for (const pm of ['pnpm', 'yarn', 'bun']) if (agent.startsWith(`${pm}/`)) return pm
  return 'npm'
}

function scaffold(dir, type, id, label) {
  if (existsSync(dir) && readdirSync(dir).some((name) => name !== '.git')) throw new Error(`${dir} is not empty`)
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`id ${JSON.stringify(id)}: lowercase letters, digits and - (give one with --id)`)
  const from = join(HERE, 'templates', type)
  const copy = (rel) => {
    for (const name of readdirSync(join(from, rel))) {
      const source = join(from, rel, name)
      if (statSync(source).isDirectory()) {
        copy(join(rel, name))
        continue
      }
      const file = join(dir, rel, name === 'gitignore' ? '.gitignore' : name)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, readFileSync(source, 'utf8').replaceAll('{{id}}', id).replaceAll('{{label}}', label).replaceAll('{{api}}', dependency('@dopame/acde-api')))
    }
  }
  copy('')
  const file = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
    // not `build`: `acde app build` runs the project's own build script (Vite, Next.js …) when it has one
  pkg.scripts = { dev: 'acde app run', package: 'acde app build', check: 'acde app check', 'install-app': 'acde app install', ...pkg.scripts }
  pkg.devDependencies = { ...pkg.devDependencies, acde: dependency('acde') }
  if (process.env.CREATE_ACDE_LOCAL) pkg.overrides = { '@dopame/acde-linux-x64': dependency('@dopame/acde-linux-x64') }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
}

function run(command, args, cwd) {
  const done = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  return done.status === 0
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (options.help) return void console.log(HELP)
  console.log(`\n${bold('acde')} ${dim(`create-acde ${VERSION}`)}\n`)
  const { dir, type, install, git } = await ask(options)
  const target = resolve(dir)
  const id = options.id ?? basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const label = options.label ?? id
  scaffold(target, type, id, label)
  console.log(`${green('✔')} ${type === 'app' ? 'An app' : 'A desktop'} ${bold(id)} in ${relative(process.cwd(), target) || '.'}`)
  const pm = packageManager()
  if (install) {
    console.log(`${dim(`… installing the dependencies with ${pm}`)}`)
    if (!run(pm, ['install'], target)) console.log(`${red('✖')} ${pm} install failed; run it in the project yourself`)
    else console.log(`${green('✔')} Dependencies installed`)
  }
  if (git && !existsSync(join(target, '.git'))) {
    try {
      execFileSync('git', ['init', '-q'], { cwd: target, stdio: 'ignore' })
      execFileSync('git', ['add', '-A'], { cwd: target, stdio: 'ignore' })
      execFileSync('git', ['commit', '-q', '-m', 'Initial commit (create-acde)'], { cwd: target, stdio: 'ignore' })
      console.log(`${green('✔')} A git repository`)
    } catch {
    }
  }
  const runScript = pm === 'npm' ? 'npm run' : pm
  const steps = [relative(process.cwd(), target) ? `cd ${relative(process.cwd(), target)}` : null, install ? null : `${pm} install`, `${runScript} dev`].filter(Boolean)
  console.log(`\n${bold('Next')}:\n  ${steps.join('\n  ')}\n\n${dim(`${runScript} dev runs it in its own window (on Linux, inside your desktop); ${runScript} package builds the acde package (.acde).`)}\n`)
}

main().catch((error) => {
  console.error(`${red('✖')} ${error.message}`)
  process.exit(1)
})
