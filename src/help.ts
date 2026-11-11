import { Color, type Palette } from './color.ts'

export interface HelpOption {
  readonly flag: string
  readonly about: string
}

export interface HelpCommand {
  readonly name: string
  readonly group: string
  readonly args: string
  readonly summary: string
  readonly about: readonly string[]
  readonly options: readonly HelpOption[]
  readonly examples: readonly string[]
}

const WINDOW_ACTIONS: readonly string[] = ['close', 'minimize', 'restore']

const SESSION: HelpOption = {
  flag: '--session PID',
  about: 'the acde dev to use (default: the one whose projects hold this directory)',
}

export class Help {
  static readonly WIDTH = 80
  static readonly GROUPS = ['Project', 'Develop', 'Inspect a running session', 'Agents'] as const

  static commands(templates: readonly string[], actions: readonly string[]): readonly HelpCommand[] {
    const inspecting = (name: string, args: string, summary: string, about: string[], options: HelpOption[] = [],
      examples: string[] = []): HelpCommand =>
      ({ name, group: 'Inspect a running session', args, summary, about, options: [...options, SESSION], examples })
    return [
      {
        name: 'new',
        group: 'Project',
        args: '[dir]',
        summary: 'Create a project from a template',
        about: [
          'Creates a project in dir and installs its dependencies, the SDK included. In a terminal it asks for '
            + 'whatever is missing; with --yes it asks nothing.',
        ],
        options: [
          { flag: '--template T', about: `the template: ${templates.join(', ')} (default: html)` },
          { flag: '--id ID', about: 'the app id (default: from the directory name)' },
          { flag: '--label NAME', about: 'the name shown on the window (default: from the id)' },
          { flag: '--backend', about: 'add a server.ts backend (html template)' },
          { flag: '--pm PM', about: 'bun, npm, pnpm or yarn (default: the one running acde)' },
          { flag: '--no-install', about: 'do not install the dependencies' },
          { flag: '--git', about: 'start a git repository' },
          { flag: '--yes', about: 'ask nothing; take the defaults' },
        ],
        examples: ['acde new my-app', 'acde new shop --template react --pm pnpm --yes'],
      },
      {
        name: 'check',
        group: 'Project',
        args: '[dir]',
        summary: 'Check the config as the runtime reads it',
        about: [
          'Checks acde.config.jsonc (or a package\'s manifest) and the acde: imports, and the capabilities a '
            + 'platform lacks in each way of running (required ones are errors, optional ones notes).',
        ],
        options: [{ flag: '--platform P', about: 'windows, macos or linux (default: this one)' }],
        examples: ['acde check', 'acde check --platform linux'],
      },
      {
        name: 'build',
        group: 'Project',
        args: '[dir]',
        summary: 'Build the project into a package',
        about: ['Builds the project into a package directory whose package.json is the manifest.'],
        options: [{ flag: '--out DIR', about: 'where to build (default: .acde)' }],
        examples: ['acde build'],
      },
      {
        name: 'install',
        group: 'Project',
        args: '[dir]',
        summary: 'Build, then install the package on this machine',
        about: [
          'Builds, then installs into $XDG_DATA_HOME/acde/packages (default ~/.local/share/acde/packages, on '
            + 'Windows %USERPROFILE%\\.local\\share\\acde\\packages); a hand-written package is linked.',
        ],
        options: [{ flag: '--out DIR', about: 'where to build first (default: .acde)' }],
        examples: ['acde install'],
      },
      {
        name: 'sdk',
        group: 'Project',
        args: '[update] [dir]',
        summary: 'Show or update the project\'s SDK',
        about: [
          'Shows the project\'s @dopame/acde-api and the version this acde pairs with. update points the '
            + 'dependency at that version\'s tarball and reinstalls with the project\'s package manager.',
        ],
        options: [],
        examples: ['acde sdk', 'acde sdk update'],
      },
      {
        name: 'dev',
        group: 'Develop',
        args: '[dir...]',
        summary: 'Run the project in acdert and reload on change',
        about: [
          'Builds, runs in acdert, and rebuilds and reloads what changed. One project: its desktop or app. '
            + 'Several projects or --desktop: all in that desktop (default: the desktop project among them, '
            + 'else dopame).',
        ],
        options: [
          { flag: '--headless', about: 'no host window (machines without a display, CI)' },
          { flag: '--app ID', about: 'with several apps in a project, the one to open' },
          { flag: '--desktop ID|DIR', about: 'run the projects in that desktop' },
          { flag: '--out DIR', about: 'where to build (default: .acde; one project only)' },
        ],
        examples: ['acde dev', 'acde dev --headless', 'acde dev ./app ./desk'],
      },
      {
        name: 'test',
        group: 'Develop',
        args: '[dir|file...]',
        summary: 'Run the end-to-end tests (*.e2e.ts)',
        about: [
          'Runs *.e2e.ts files (import from acde/test); each test gets a fresh, isolated acde dev, headless '
            + 'unless --headed. What a failing test left goes to <project>/.acde/test-results.',
        ],
        options: [
          { flag: '-t PATTERN', about: 'only the tests whose names match' },
          { flag: '--headed', about: 'show the windows' },
          { flag: '--desktop ID|DIR', about: 'run the app in that desktop' },
          { flag: '--timeout MS', about: 'per test (default: 60000)' },
          { flag: '--bail', about: 'stop at the first failure' },
          { flag: '--workers N', about: 'files at once (default: half the cores, at most 4; 1 headed or with --bail)' },
          { flag: '--retries N', about: 'run a failing test again (passing later means flaky; default: 0)' },
          { flag: '--trace', about: 'a screenshot after every step and trace.html for every test' },
          { flag: '--video[=on]', about: 'an animated PNG of the screen of failing tests (=on: of every test)' },
          { flag: '-u, --update-screenshots', about: 'rewrite the screenshot baselines' },
        ],
        examples: ['acde test', 'acde test e2e/notes.e2e.ts -t saves --headed'],
      },
      {
        name: 'doctor',
        group: 'Develop',
        args: '[dir]',
        summary: 'Check this machine for acde dev and say how to fix it',
        about: [
          'Checks acde on PATH, Bun and Node.js, acdert (found, runs, pairs with this acde, its own check of the '
            + 'GPU and its files), running sessions, the project in dir and the agent skill. Exit code 1 on an error.',
        ],
        options: [
          { flag: '--online', about: 'also check whether a newer acde is out' },
          { flag: '--json', about: 'one JSON object' },
          { flag: '--fix', about: 'then fix what acde may (the skill, .acde/ in .gitignore, the sessions directory)' },
          { flag: '--yes', about: 'with --fix, also do what downloads or stops something, without asking' },
        ],
        examples: ['acde doctor', 'acde doctor --fix'],
      },
      inspecting('webs', '', 'List the pages acdert runs', ['The webs (windows\' pages) of the session, and the '
        + 'camera or microphone prompts that wait.'], [], ['acde webs']),
      inspecting('inspect', '', 'Print the screen as text, with refs', [
        'The windows, then the elements of the focused window, one per line with a ref such as w1.12 that act takes.',
      ], [
        { flag: '--find TEXT', about: 'only elements whose name or value contains TEXT' },
        { flag: '--window W', about: 'that window instead of the focused one' },
        { flag: '--all', about: 'every window not marked [minimized], and elements hidden by opacity: 0' },
        { flag: '--offscreen', about: 'also elements scrolled out of view' },
      ], ['acde inspect', 'acde inspect --find Save']),
      inspecting('query', '<selector>', 'Find elements by CSS selector', [
        'The elements a CSS selector matches in the focused window, each with a ref act takes; also what inspect '
          + 'leaves out (not rendered ones are marked [hidden]).',
      ], [
        { flag: '--window W', about: 'that window instead of the focused one' },
        { flag: '--ref REF', about: 'only under that element' },
        { flag: '--limit N', about: 'at most N elements (default: 3000)' },
      ], ['acde query "button.primary"']),
      inspecting('act', '<ref> <action> [arg]', 'Click, type, press keys… on a ref', [
        'Performs one action on a ref from inspect or query and prints what changed.',
        `Actions: ${actions.filter((a) => !WINDOW_ACTIONS.includes(a)).join(', ')}. A window ref (w1) also takes `
          + `${WINDOW_ACTIONS.join(', ')}.`,
        'key takes key names separated by spaces (ctrl+a backspace); type and settext take text; drag takes the '
          + 'target ref; scroll takes pixels.',
      ], [], ['acde act w1.12 click', 'acde act w1.3 type "hello"', 'acde act w1.3 key "ctrl+a backspace"']),
      inspecting('eval', '<web> <code|->', 'Evaluate JavaScript in a page', [
        'Runs code in a web (a web name, an app id or desktop) and prints the result as JSON; - reads the code '
          + 'from stdin.',
      ], [], ['acde eval notes "document.title"']),
      inspecting('shot', '<web>', 'Take a PNG of a window', ['A PNG of the web\'s window; prints its path.'],
        [{ flag: '-o, --output FILE', about: 'where to write it (default: ./<web>.png)' }], ['acde shot notes']),
      inspecting('screen', '', 'Take a PNG of the whole screen', ['A PNG of the whole screen, every window composed.'],
        [{ flag: '-o, --output FILE', about: 'where to write it (default: ./screen.png)' }], ['acde screen']),
      inspecting('console', '', 'Print the pages\' console output and errors', [
        'The pages\' console.* lines and uncaught errors.',
      ], [
        { flag: '--web W', about: 'only that page' },
        { flag: '--level L', about: 'log, info, warn, error, debug or errors' },
        { flag: '--since S', about: 'reload (since acde dev last reloaded) or N (from entry N on)' },
        { flag: '--follow', about: 'keep printing new entries' },
      ], ['acde console --level errors']),
      inspecting('network', '', 'Print the pages\' requests', [
        'The pages\' fetch / XHR / WebSocket / EventSource requests and the images, stylesheets and fonts they '
          + 'load, and how they ended.',
      ], [
        { flag: '--web W', about: 'only that page' },
        { flag: '--failed', about: 'only failed requests and status 400 or more' },
        { flag: '--since S', about: 'reload or N, as for console' },
        { flag: '--follow', about: 'keep printing new requests' },
      ], ['acde network --failed']),
      inspecting('pointer', '<x> <y>', 'Move the pointer to a screen point', [
        'Moves the pointer as a real move (hover, screen edges); in a host window the screen is its content area.',
      ], [], ['acde pointer 0 0']),
      inspecting('permissions', '', 'List camera and microphone prompts', [
        'The camera and microphone prompts that wait and the decisions made (other capabilities are granted '
          + 'when declared).',
      ], [], ['acde permissions']),
      inspecting('allow', '[<prompt>|<app> <capability>]', 'Allow a waiting prompt', [
        'Allows the only waiting prompt, the one with that id (acde permissions shows it), or the one of that app '
          + 'for that capability.',
      ], [{ flag: '--all', about: 'every waiting prompt' }], ['acde allow', 'acde allow recorder microphone']),
      inspecting('deny', '[<prompt>|<app> <capability>]', 'Deny a waiting prompt', [
        'Denies the only waiting prompt, the one with that id, or the one of that app for that capability.',
      ], [{ flag: '--all', about: 'every waiting prompt' }], ['acde deny']),
      inspecting('revoke', '<app> <capability>', 'Take back a decision', ['Takes back a decision, so the app is asked '
        + 'again.'], [], ['acde revoke recorder microphone']),
      inspecting('stop', '', 'End the session', [
        'Ends the acde dev and its acdert, as closing its last window does; for one started in the background.',
      ], [], ['acde stop']),
      {
        name: 'mcp',
        group: 'Agents',
        args: '',
        summary: 'Serve the session tools over MCP (stdio)',
        about: ['An MCP server on stdio with the session tools, and start / logs to run acde dev itself.'],
        options: [SESSION],
        examples: ['claude mcp add acde -- acde mcp'],
      },
      {
        name: 'skills',
        group: 'Agents',
        args: '[install|remove|path]',
        summary: 'Install the acde skill for coding agents',
        about: [
          'The acde skill (how to build, run, inspect and test with acde, in the Agent Skills format): where it '
            + 'is installed; install links it into ~/.agents/skills and the skills directory of every agent found '
            + 'here; remove takes it away; path prints its directory.',
        ],
        options: [
          { flag: '--agent ID,...', about: 'only for those agents' },
          { flag: '--dir DIR', about: 'into DIR' },
          { flag: '--copy', about: 'a copy, not a link' },
        ],
        examples: ['acde skills install'],
      },
    ]
  }

  static wrap(text: string, width: number, indent: string): string[] {
    const lines: string[] = []
    let line = ''
    for (const word of text.split(/\s+/).filter(Boolean)) {
      if (line && Color.width(line) + 1 + Color.width(word) > width - indent.length) {
        lines.push(indent + line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(indent + line)
    return lines
  }

  static overview(commands: readonly HelpCommand[], version: string, c: Palette = Color.palette()): string {
    const pad = Math.max(...commands.map((command) => command.name.length)) + 2
    const out = [`acde ${version}: build, run and test apps for Dopame`, '']
    out.push(`${c.heading('Usage:')} acde <command> [options]`)
    for (const group of Help.GROUPS) {
      out.push('', c.heading(`${group}:`))
      for (const command of commands.filter((item) => item.group === group))
        out.push(`  ${c.name(command.name.padEnd(pad))}${command.summary}`)
    }
    out.push('', c.heading('Options:'))
    out.push(`  ${c.option('-h, --help'.padEnd(15))}this help; acde <command> --help: that command's`)
    out.push(`  ${c.option('-v, --version'.padEnd(15))}the versions of acde, the SDK and the acdert it finds`)
    out.push('', `Run ${c.name('acde <command> --help')} for a command's options and examples.`)
    return out.join('\n')
  }

  static command(command: HelpCommand, c: Palette = Color.palette()): string {
    const usage = ['acde', command.name, command.args, command.options.length ? '[options]' : '']
      .filter(Boolean).join(' ')
    const out = [`${c.heading('Usage:')} ${usage}`, '']
    for (const paragraph of command.about) out.push(...Help.wrap(paragraph, Help.WIDTH, ''))
    if (command.options.length) {
      const pad = Math.min(26, Math.max(...command.options.map((option) => option.flag.length)) + 2)
      out.push('', c.heading('Options:'))
      for (const option of command.options) {
        const first = option.flag.length + 2 > pad
        const [head = '', ...rest] = Help.wrap(option.about, Help.WIDTH, ' '.repeat(pad + 2))
        if (first) out.push(`  ${c.option(option.flag)}`, head, ...rest)
        else out.push(`  ${c.option(option.flag.padEnd(pad))}${head.trimStart()}`, ...rest)
      }
    }
    if (command.examples.length) {
      out.push('', c.heading('Examples:'))
      for (const example of command.examples) out.push(`  ${c.dim('$')} ${example}`)
    }
    return out.join('\n')
  }
}
