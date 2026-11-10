import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Agent {
  readonly id: string
  readonly name: string
  readonly skills: string
  readonly marks: readonly string[]
}

type Row = readonly [id: string, name: string, skills: string, ...marks: string[]]

export class Agents {
  static readonly SHARED = 'agents'

  static all(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Agent[] {
    const set = (name: string, fallback: string) => env[name]?.trim() || fallback
    const h = (...path: string[]) => join(home, ...path)
    const config = set('XDG_CONFIG_HOME', h('.config'))
    const c = (...path: string[]) => join(config, ...path)
    const shared = h('.agents', 'skills')
    const claude = set('CLAUDE_CONFIG_DIR', h('.claude'))
    const codex = set('CODEX_HOME', h('.codex'))
    const vibe = set('VIBE_HOME', h('.vibe'))
    const hermes = set('HERMES_HOME', h('.hermes'))
    const autohand = set('AUTOHAND_HOME', h('.autohand'))
    const grok = set('GROK_HOME', h('.grok'))
    const sarvam = set('SARVAM_HOME', h('.sarvam'))
    const roaming = set('APPDATA', h('AppData', 'Roaming'))
    const reasonix = set('REASONIX_HOME', process.platform === 'win32' ? join(roaming, 'reasonix') : h('.reasonix'))
    const openclaw = ['.openclaw', '.clawdbot', '.moltbot'].map((dir) => h(dir))
    const rows: Row[] = [
      [Agents.SHARED, 'any other agent that reads ~/.agents/skills', shared],
      ['adal', 'AdaL', h('.adal', 'skills'), h('.adal')],
      ['aider-desk', 'AiderDesk', h('.aider-desk', 'skills'), h('.aider-desk')],
      ['amp', 'Amp', c('agents', 'skills'), c('amp')],
      ['antigravity', 'Antigravity', h('.gemini', 'config', 'skills'), h('.gemini', 'antigravity')],
      ['antigravity-cli', 'Antigravity CLI', h('.gemini', 'config', 'skills'), h('.gemini', 'antigravity-cli')],
      ['astrbot', 'AstrBot', h('.astrbot', 'data', 'skills'), h('.astrbot')],
      ['augment', 'Augment', h('.augment', 'skills'), h('.augment')],
      ['autohand-code', 'Autohand Code CLI', join(autohand, 'skills'), autohand],
      ['bob', 'IBM Bob', h('.bob', 'skills'), h('.bob')],
      ['claude-code', 'Claude Code', join(claude, 'skills'), claude],
      ['cline', 'Cline', shared, h('.cline')],
      ['codearts-agent', 'CodeArts Agent', h('.codeartsdoer', 'skills'), h('.codeartsdoer')],
      ['codebuddy', 'CodeBuddy', h('.codebuddy', 'skills'), h('.codebuddy')],
      ['codemaker', 'Codemaker', h('.codemaker', 'skills'), h('.codemaker')],
      ['codestudio', 'Code Studio', h('.codestudio', 'skills'), h('.codestudio')],
      ['codex', 'Codex', shared, codex, '/etc/codex'],
      ['command-code', 'Command Code', h('.commandcode', 'skills'), h('.commandcode')],
      ['continue', 'Continue', h('.continue', 'skills'), h('.continue')],
      ['cortex', 'Cortex Code', h('.snowflake', 'cortex', 'skills'), h('.snowflake', 'cortex')],
      ['crush', 'Crush', h('.config', 'crush', 'skills'), h('.config', 'crush')],
      ['cursor', 'Cursor', h('.cursor', 'skills'), h('.cursor')],
      ['deepagents', 'Deep Agents', h('.deepagents', 'agent', 'skills'), h('.deepagents')],
      ['devin', 'Devin for Terminal', c('devin', 'skills'), c('devin')],
      ['dexto', 'Dexto', shared, h('.dexto')],
      ['droid', 'Droid', h('.factory', 'skills'), h('.factory')],
      ['firebender', 'Firebender', h('.firebender', 'skills'), h('.firebender')],
      ['forgecode', 'ForgeCode', h('.forge', 'skills'), h('.forge')],
      ['fx', 'fx', shared, h('.fx')],
      ['gemini-cli', 'Gemini CLI', h('.gemini', 'skills'), h('.gemini')],
      ['github-copilot', 'GitHub Copilot', h('.copilot', 'skills'), h('.copilot')],
      ['goose', 'Goose', c('goose', 'skills'), c('goose')],
      ['grok', 'Grok Build', join(grok, 'skills'), grok],
      ['hermes-agent', 'Hermes Agent', join(hermes, 'skills'), hermes],
      ['iflow-cli', 'iFlow CLI', h('.iflow', 'skills'), h('.iflow')],
      ['inference-sh', 'inference.sh', h('.inferencesh', 'skills'), h('.inferencesh')],
      ['jazz', 'Jazz', h('.jazz', 'skills'), h('.jazz')],
      ['junie', 'Junie', h('.junie', 'skills'), h('.junie')],
      ['kilo', 'Kilo Code', h('.kilo', 'skills'), h('.kilo'), h('.kilocode')],
      ['kimchi', 'Kimchi', h('.config', 'kimchi', 'harness', 'skills'), h('.config', 'kimchi')],
      ['kimi-code-cli', 'Kimi Code CLI', shared, h('.kimi-code'), h('.kimi')],
      ['kiro-cli', 'Kiro CLI', h('.kiro', 'skills'), h('.kiro')],
      ['kode', 'Kode', h('.kode', 'skills'), h('.kode')],
      ['lingma', 'Lingma', h('.lingma', 'skills'), h('.lingma')],
      ['loaf', 'Loaf', shared, h('.loaf')],
      ['mcpjam', 'MCPJam', h('.mcpjam', 'skills'), h('.mcpjam')],
      ['minimax-code', 'MiniMax Code', h('.minimax', 'skills'), h('.minimax')],
      ['mistral-vibe', 'Mistral Vibe', join(vibe, 'skills'), vibe],
      ['moxby', 'Moxby', h('.moxby', 'skills'), h('.moxby')],
      ['mux', 'Mux', h('.mux', 'skills'), h('.mux')],
      ['neovate', 'Neovate', h('.neovate', 'skills'), h('.neovate')],
      ['ona', 'Ona', h('.ona', 'skills'), h('.ona')],
      ['openclaw', 'OpenClaw', join(openclaw.find((dir) => existsSync(dir)) ?? openclaw[0]!, 'skills'), ...openclaw],
      ['opencode', 'OpenCode', c('opencode', 'skills'), c('opencode')],
      ['openhands', 'OpenHands', h('.openhands', 'skills'), h('.openhands')],
      ['pi', 'Pi', shared, h('.pi', 'agent')],
      ['pochi', 'Pochi', h('.pochi', 'skills'), h('.pochi')],
      ['posit-assistant', 'Posit Assistant', h('.posit', 'assistant', 'skills'), h('.posit', 'assistant')],
      ['qoder', 'Qoder', h('.qoder', 'skills'), h('.qoder')],
      ['qoder-cn', 'Qoder CN', h('.qoder-cn', 'skills'), h('.qoder-cn')],
      ['qwen-code', 'Qwen Code', h('.qwen', 'skills'), h('.qwen')],
      ['reasonix', 'Reasonix', join(reasonix, 'skills'), reasonix],
      ['replit', 'Replit', c('agents', 'skills'), c('replit')],
      ['roo', 'Roo Code', h('.roo', 'skills'), h('.roo')],
      ['rovodev', 'Rovo Dev', h('.rovodev', 'skills'), h('.rovodev')],
      ['sarvam-code', 'Sarvam Code', shared, sarvam],
      ['tabnine-cli', 'Tabnine CLI', h('.tabnine', 'agent', 'skills'), h('.tabnine')],
      ['terramind', 'Terramind', h('.terramind', 'skills'), h('.terramind')],
      ['tinycloud', 'Tinycloud', h('.tinycloud', 'skills'), h('.tinycloud')],
      ['trae', 'Trae', h('.trae', 'skills'), h('.trae')],
      ['trae-cn', 'Trae CN', h('.trae-cn', 'skills'), h('.trae-cn')],
      ['warp', 'Warp', shared, h('.warp')],
      ['windsurf', 'Windsurf', h('.codeium', 'windsurf', 'skills'), h('.codeium', 'windsurf')],
      ['zcode', 'ZCode', h('.zcode', 'skills'), h('.zcode')],
      ['zed', 'Zed', shared, c('zed'), join(roaming, 'Zed')],
      ['zencoder', 'Zencoder', h('.zencoder', 'skills'), h('.zencoder')],
    ]
    return rows.map(([id, name, skills, ...marks]) => ({ id, name, skills, marks }))
  }

  static found(agent: Agent): boolean {
    return agent.id === Agents.SHARED || agent.marks.some((mark) => existsSync(mark))
  }

  static named(ids: readonly string[], all: readonly Agent[]): Agent[] {
    return ids.map((id) => {
      const agent = all.find((known) => known.id === id)
      if (!agent) throw new Error(`--agent ${id}: not an agent acde knows (${all.map((known) => known.id).join(', ')}); ` +
        'for any other, pass its skills directory with --dir')
      return agent
    })
  }
}
