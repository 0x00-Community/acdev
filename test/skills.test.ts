import { afterAll, describe, expect, test } from 'bun:test'
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { skillProblems } from '../scripts/skill.ts'
import { Agents } from '../src/agents.ts'
import { cleanup, collect, env, tmp } from './helpers.ts'

const ROOT = join(import.meta.dir, '..')
const CLI = join(ROOT, 'src/cli.ts')
const SKILL = join(ROOT, 'skills/acde')

function cli(args: string[], home: string, cwd = home) {
  const vars = {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '', XDG_DATA_HOME: '', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '',
    APPDATA: '',
  }
  return collect([process.execPath, CLI, ...args], { cwd, env: env(vars) })
}

function broken(change: (dir: string) => void): string[] {
  const dir = join(tmp(), 'acde')
  cpSync(SKILL, dir, { recursive: true })
  change(dir)
  return skillProblems(dir)
}

function edit(file: string, change: (text: string) => string): void {
  writeFileSync(file, change(readFileSync(file, 'utf8')))
}

afterAll(cleanup)

describe('the skill', () => {
  test('follows the Agent Skills format and the rules for its references', () => {
    expect(skillProblems(SKILL)).toEqual([])
  })

  test('names every command acde has', async () => {
    const usage = (await cli(['--help'], tmp())).stdout
    const commands = [...usage.matchAll(/^  ([a-z]+) /gm)].map((match) => match[1]!)
    const flags = [...new Set([...usage.matchAll(/(?<![\w-])--[a-z][a-z-]*/g)].map((match) => match[0]))]
    expect(commands).toContain('skills')
    const reference = readFileSync(join(SKILL, 'references/reference/cli.md'), 'utf8')
    expect(commands.filter((command) => !reference.includes(`acde ${command}`))).toEqual([])
    expect(flags.filter((flag) => !reference.includes(flag))).toEqual([])
  })

  test('install.md, the steps an agent follows, uses commands acde has and is where the skill says', async () => {
    const usage = (await cli(['--help'], tmp())).stdout
    const commands = new Set([...usage.matchAll(/^  ([a-z]+) /gm)].map((match) => match[1]!))
    const steps = readFileSync(join(ROOT, 'install.md'), 'utf8')
    const code = [...steps.matchAll(/^```\w*\n([\s\S]*?)^```$|`([^`\n]+)`/gm)]
      .flatMap((match) => (match[1] ?? match[2]!).split('\n'))
    const used = code.flatMap((line) => /^acde ([a-z]+)\b/.exec(line)?.[1] ?? [])
    expect(used.length).toBeGreaterThan(8)
    expect(used.filter((command) => !commands.has(command))).toEqual([])
    const prompt = 'Read https://pkgs.dopame.ai/acde/install.md and follow it to set up acde on this machine.'
    for (const page of ['start/install.md', 'guide/agents.md']) {
      expect(readFileSync(join(SKILL, 'references', page), 'utf8')).toContain(prompt)
    }
  })

  test('names every tool acde mcp has', () => {
    const source = ['src/mcp.ts', 'src/mcppage.ts'].map((file) => readFileSync(join(ROOT, file), 'utf8')).join('\n')
    const tools = [...source.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((match) => match[1]!)
    expect(tools.length).toBeGreaterThan(10)
    expect(tools).toContain('clock')
    const guide = readFileSync(join(SKILL, 'references/guide/mcp.md'), 'utf8')
    expect(tools.filter((tool) => !guide.includes(`\`${tool}\``))).toEqual([])
  })

  test('the check reports what breaks the format', () => {
    const skill = (change: (text: string) => string) => broken((dir) => edit(join(dir, 'SKILL.md'), change))
    expect(skill((text) => text.replace('name: acde', 'name: Acde'))[0]).toContain('name "Acde"')
    expect(skill((text) => text.replace(/^description: .*$/m, 'description:'))[0])
      .toContain('description is 0 characters')
    expect(skill((text) => text.replace('name: acde', 'name: acde\nversion: 1'))[0])
      .toContain('frontmatter key version')
    expect(skill((text) => text + '\nline'.repeat(500))[0]).toContain('keep it to 500')
    expect(skill((text) => `${text}\n## More\n`)[0]).toContain('is not the last section')
    expect(skill((text) => text.replace('## References', '## Files')).join('\n'))
      .toContain('no "## References" section')
  })

  test('the check reports references the docs cannot be built from', () => {
    const page = 'references/guide/dev.md'
    const said = (change: (text: string) => string) => broken((dir) => edit(join(dir, page), change)).join('\n')
    expect(said((text) => text.replace('# acde dev', '---\ntitle: acde dev\n---')))
      .toContain(`${page}:1: start with "# Title"`)
    expect(said((text) => `${text}\n# Again\n`)).toContain('a second "# " heading')
    expect(said((text) => `${text}\n[x](/guide/tools/)\n`)).toContain('a path from the site root')
    expect(said((text) => `${text}\n[x](https://docs.dopame.ai/guide/tools/)\n`)).toContain('link the reference file')
    expect(said((text) => `${text}\n[x](nowhere.md)\n`)).toContain('no such file')
    expect(said((text) => `${text}\n[x](tools.md#no-such-heading)\n`))
      .toContain('no heading with the anchor #no-such-heading')
    expect(said((text) => `${text}\n[x](../../../../outside.md)\n`)).toContain('leaves the skill directory')
    expect(said((text) => `${text}\n:::note\nhi\n:::\n`)).toContain('a ::: directive')
    expect(said((text) => `${text}\n<Card title="x" />\n`)).toContain('an HTML or JSX tag')
    expect(said((text) => `${text}\n\`\`\`html\n<p>fine in code</p>\n\`\`\`\n`)).toBe('')
    expect(broken((dir) => writeFileSync(join(dir, 'references/guide/new-page.md'), '# New\n\nText.\n')).join('\n'))
      .toContain('references/guide/new-page.md: the References section of SKILL.md does not list it')
    expect(broken((dir) => writeFileSync(join(dir, 'references/Loose.md'), '# Loose\n\nText.\n')).join('\n'))
      .toContain('references/Loose.md: a reference is references/<group>/<page>.md')
  })
})

describe('acde skills', () => {
  test('lists each skills directory once, the shared one first', () => {
    const home = tmp()
    const agents = Agents.all({}, home)
    expect(new Set(agents.map((agent) => agent.id)).size).toBe(agents.length)
    expect(agents[0]).toEqual({
      id: 'agents',
      name: 'any other agent that reads ~/.agents/skills',
      skills: join(home, '.agents', 'skills'),
      marks: [],
    })
    expect(agents.find((agent) => agent.id === 'codex')!.skills).toBe(join(home, '.agents', 'skills'))
    const skills = (env: Record<string, string>, id: string) =>
      Agents.all(env, home).find((agent) => agent.id === id)!.skills
    expect(skills({ CLAUDE_CONFIG_DIR: join(home, 'cc') }, 'claude-code'))
      .toBe(join(home, 'cc', 'skills'))
    expect(skills({ XDG_CONFIG_HOME: join(home, 'cfg') }, 'opencode'))
      .toBe(join(home, 'cfg', 'opencode', 'skills'))
  })

  test('install links the skill for the agents found, status and remove follow', async () => {
    const home = tmp()
    mkdirSync(join(home, '.claude'))
    mkdirSync(join(home, '.cursor', 'skills'), { recursive: true })
    const shared = join(home, '.agents', 'skills', 'acde')
    const claude = join(home, '.claude', 'skills', 'acde')
    const cursor = join(home, '.cursor', 'skills', 'acde')

    const before = await cli(['skills'], home)
    expect(before.code).toBe(0)
    expect(before.stdout).toContain(`skill   ${realpathSync(SKILL)}`)
    expect(before.stdout).toContain(`not installed   ${claude} (Claude Code)`)
    expect(before.stdout).not.toContain('.gemini')
    expect(before.stdout).toContain('acde skills install')

    const installed = await cli(['skills', 'install'], home)
    expect(installed.code).toBe(0)
    expect(installed.stdout).toContain(`acde: skill linked to ${claude} (Claude Code)`)
    for (const dest of [shared, claude, cursor]) {
      expect(lstatSync(dest).isSymbolicLink()).toBe(true)
      expect(realpathSync(dest)).toBe(realpathSync(SKILL))
      expect(existsSync(join(dest, 'references/reference/cli.md'))).toBe(true)
    }
    expect(existsSync(join(home, '.gemini'))).toBe(false)

    const again = await cli(['skills', 'install'], home)
    expect(again.code).toBe(0)
    const status = await cli(['skills'], home)
    expect(status.stdout).toContain(`link, current   ${shared} (Cline, Codex,`)
    expect(status.stdout).toContain('Zed, any other agent that reads ~/.agents/skills)')
    expect(status.stdout).toContain(`link, current   ${cursor} (Cursor)`)

    const removed = await cli(['skills', 'remove'], home)
    expect(removed.stdout).toContain(`acde: skill removed from ${claude}`)
    for (const dest of [shared, claude, cursor]) expect(lstatSync(dest, { throwIfNoEntry: false })).toBeUndefined()
    const made = join(home, '.claude', 'skills')
    expect(removed.stdout).toContain(`acde: removed ${made}, which skills install had created`)
    expect(existsSync(join(home, '.agents'))).toBe(false)
    expect(existsSync(join(home, '.claude'))).toBe(true)
    expect(existsSync(join(home, '.cursor', 'skills'))).toBe(true)
    expect(existsSync(join(SKILL, 'SKILL.md'))).toBe(true)
    expect((await cli(['skills', 'remove'], home)).stdout).toContain('not installed anywhere')
  })

  test('--agent, --dir and --copy choose where and how', async () => {
    const home = tmp()
    const gemini = join(home, '.gemini', 'skills', 'acde')
    const chosen = await cli(['skills', 'install', '--agent', 'gemini-cli', '--copy'], home)
    expect(chosen.stdout.trim()).toBe(`acde: skill copied to ${gemini} (Gemini CLI)`)
    expect(lstatSync(gemini).isDirectory()).toBe(true)
    expect(readFileSync(join(gemini, 'SKILL.md'), 'utf8')).toBe(readFileSync(join(SKILL, 'SKILL.md'), 'utf8'))
    expect((await cli(['skills'], home)).stdout).toContain(`copy, current   ${gemini} (Gemini CLI)`)
    writeFileSync(join(gemini, 'references/reference/cli.md'), 'older\n')
    expect((await cli(['skills'], home)).stdout).toContain(`copy, outdated  ${gemini} (Gemini CLI)`)
    expect((await cli(['skills', 'install', '--agent', 'gemini-cli', '--copy'], home)).code).toBe(0)
    expect((await cli(['skills'], home)).stdout).toContain(`copy, current   ${gemini} (Gemini CLI)`)

    const project = join(home, 'project')
    mkdirSync(project)
    const local = await cli(['skills', 'install', '--dir', '.agents/skills'], home, project)
    const dest = join(realpathSync(project), '.agents', 'skills', 'acde')
    expect(local.stdout.trim()).toBe(`acde: skill linked to ${dest}`)
    const inProject = (...args: string[]) => cli(['skills', ...args, '--dir', '.agents/skills'], home, project)
    expect((await inProject()).stdout).toContain(`link, current   ${dest}`)
    expect((await inProject('remove')).stdout).toContain(`removed from ${dest}`)
    expect(existsSync(join(project, '.agents'))).toBe(false)
    expect(existsSync(gemini)).toBe(true)

    expect((await cli(['skills', 'path'], home)).stdout.trim()).toBe(realpathSync(SKILL))
  })

  test('a link whose target is gone is reported and replaced', async () => {
    const home = tmp()
    const kept = join(home, 'kept')
    cpSync(SKILL, kept, { recursive: true })
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    const shared = join(home, '.agents', 'skills', 'acde')
    symlinkSync(kept, shared, process.platform === 'win32' ? 'junction' : 'dir')
    expect((await cli(['skills'], home)).stdout).toContain(`link, outdated  ${shared}`)
    rmSync(kept, { recursive: true })
    expect((await cli(['skills'], home)).stdout).toContain(`link, broken    ${shared}`)
    expect((await cli(['skills', 'install'], home)).code).toBe(0)
    expect(realpathSync(shared)).toBe(realpathSync(SKILL))
  })

  test('refuses what it cannot do', async () => {
    const home = tmp()
    const foreign = join(home, '.agents', 'skills', 'acde')
    mkdirSync(foreign, { recursive: true })
    writeFileSync(join(foreign, 'SKILL.md'), '---\nname: other\ndescription: Not ours.\n---\n')
    const blocked = await cli(['skills', 'install'], home)
    expect(blocked.code).toBe(1)
    expect(blocked.stderr).toContain(`${foreign}: not the acde skill`)
    expect(readFileSync(join(foreign, 'SKILL.md'), 'utf8')).toContain('name: other')
    expect((await cli(['skills'], home)).stdout).toContain(`another skill   ${foreign}`)
    expect((await cli(['skills', 'remove'], home)).stdout).toContain('not installed anywhere')
    expect(existsSync(join(foreign, 'SKILL.md'))).toBe(true)

    const said = async (...args: string[]) => (await cli(['skills', ...args], home)).stderr
    expect(await said('update')).toContain('skills update: one of status, install, remove, path')
    expect(await said('install', '--agent', 'nobody')).toContain('--agent nobody: not an agent acde knows')
    expect(await said('install', '--agent', 'codex', '--dir', 'x')).toContain('--agent or --dir, not both')
    expect((await cli(['skills', 'remove', '--copy'], home)).stderr).toContain('--copy is for skills install')
  })
})
