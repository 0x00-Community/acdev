import type { PackageManager } from './pm.ts'

export type Kind = 'app' | 'desktop'

export interface Starter {
  readonly name: string
  readonly label: string
  readonly hint: string
  readonly kind: Kind
  readonly scaffold?: (dir: string, pm: PackageManager) => readonly string[]
  readonly server?: string
}

const vite = (template: string) => (dir: string, pm: PackageManager) =>
  pm.exec('create-vite@latest', [dir, '--template', template, '--no-interactive', '--no-immediate'])

export const STARTERS: readonly Starter[] = [
  { name: 'html', label: 'HTML', hint: 'index.html + JS, an optional server.ts backend; no framework', kind: 'app' },
  { name: 'react', label: 'React', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('react-ts') },
  { name: 'vue', label: 'Vue', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('vue-ts') },
  { name: 'svelte', label: 'Svelte', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('svelte-ts') },
  { name: 'solid', label: 'Solid', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('solid-ts') },
  { name: 'preact', label: 'Preact', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('preact-ts') },
  { name: 'vanilla', label: 'Vanilla', hint: 'Vite, TypeScript', kind: 'app', scaffold: vite('vanilla-ts') },
  {
    name: 'next',
    label: 'Next.js',
    hint: 'server rendering, App Router',
    kind: 'app',
    server: 'its own server: API routes in app/api',
    scaffold: (dir, pm) =>
      pm.exec('create-next-app@latest', [
        dir,
        '--yes',
        '--ts',
        '--app',
        `--use-${pm.name}`,
        '--skip-install',
        '--disable-git',
        '--no-agent-feedback',
      ]),
  },
  {
    name: 'nuxt',
    label: 'Nuxt',
    hint: 'server rendering',
    kind: 'app',
    server: 'its own server: API routes in server/api',
    scaffold: (dir, pm) =>
      pm.exec('create-nuxt@latest', [
        dir,
        '--template',
        'minimal',
        '--no-install',
        '--no-gitInit',
        '--packageManager',
        pm.name,
      ]),
  },
  {
    name: 'sveltekit',
    label: 'SvelteKit',
    hint: 'server rendering',
    kind: 'app',
    server: 'its own server: +server.ts endpoints in src/routes',
    scaffold: (dir, pm) =>
      pm.exec('sv@latest', ['create', dir, '--template', 'minimal', '--types', 'ts', '--no-add-ons', '--no-install']),
  },
  {
    name: 'astro',
    label: 'Astro',
    hint: 'static pages',
    kind: 'app',
    server: 'its own server: endpoints in src/pages, with a server adapter',
    scaffold: (dir, pm) =>
      pm.exec('create-astro@latest', [
        dir,
        '--template',
        'minimal',
        '--no-install',
        '--no-git',
        '--no-ai',
        '--yes',
        '--skip-houston',
      ]),
  },
  {
    name: 'desktop',
    label: 'Desktop',
    hint: 'a full-screen page behind every window, its services and apps',
    kind: 'desktop',
    server: 'no backend: desktop services run in the runtime',
  },
]
