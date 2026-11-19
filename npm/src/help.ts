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

const WINDOW_ACTIONS: readonly string[] = ['close', 'minimize', 'restore', 'fill', 'fullscreen']

const SESSION: HelpOption = {
  flag: '--session PID|vm',
  about: 'The acdev dev to use (default: the one whose projects hold this directory); vm: the logged-in session in the '
    + 'guest of acdev vm',
}

export class Help {
  static readonly WIDTH = 80
  static readonly MAX = 100
  static readonly MIN = 40
  static readonly GROUPS = ['Project', 'Develop', 'Inspect a running session', 'Emulator', 'Agents'] as const

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
          { flag: '--template T', about: `The template: ${templates.join(', ')} (default: html)` },
          { flag: '--id ID', about: 'The app id (default: from the directory name)' },
          { flag: '--label NAME', about: 'The name shown on the window (default: from the id)' },
          { flag: '--backend', about: 'Add a server.ts backend (html and the Vite templates)' },
          { flag: '--pm PM', about: 'One of bun, npm, pnpm, yarn (default: the one running acdev)' },
          { flag: '--no-install', about: 'Do not install the dependencies' },
          { flag: '--git', about: 'Start a git repository' },
          { flag: '--yes', about: 'Ask nothing; take the defaults' },
        ],
        examples: ['acdev new my-app', 'acdev new shop --template react --pm pnpm --yes'],
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
        options: [{ flag: '--platform P', about: 'One of windows, macos, linux (default: this one)' }],
        examples: ['acdev check', 'acdev check --platform linux'],
      },
      {
        name: 'build',
        group: 'Project',
        args: '[dir]',
        summary: 'Build the project into a package',
        about: ['Builds the project into a package directory whose package.json is the manifest.'],
        options: [{ flag: '--out DIR', about: 'Where to build (default: .acde)' }],
        examples: ['acdev build'],
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
        options: [{ flag: '--out DIR', about: 'Where to build first (default: .acde)' }],
        examples: ['acdev install'],
      },
      {
        name: 'uninstall',
        group: 'Project',
        args: '[id|dir]',
        summary: 'Remove a package acdev install put on this machine',
        about: [
          'Removes what acdev install put there (a link: only the link). Says what first and asks; stops when '
            + 'an acdev dev uses it. No argument: lists the installed packages.',
          'The apps\' data (their storage and backend data) stays unless --data is given; in a terminal it asks.',
          'Exit code 1: an acdev dev uses it, or a wrong argument; 2: not installed; 3: not confirmed.',
        ],
        options: [
          { flag: '--yes', about: 'Remove without asking (the data stays unless --data)' },
          { flag: '--data', about: 'Also remove the apps\' data' },
          { flag: '--keep-data', about: 'Keep the apps\' data without asking' },
        ],
        examples: ['acdev uninstall', 'acdev uninstall com.example.app --yes --data'],
      },
      {
        name: 'sdk',
        group: 'Project',
        args: '[update] [dir]',
        summary: 'Show or update the project\'s SDK',
        about: [
          'Shows the project\'s @dopame/acde-api and the version this acdev pairs with. update points the '
            + 'dependency at that version\'s tarball and reinstalls with the project\'s package manager.',
        ],
        options: [],
        examples: ['acdev sdk', 'acdev sdk update'],
      },
      {
        name: 'dev',
        group: 'Develop',
        args: '[dir...]',
        summary: 'Run the project in acdev runtime and reload on change',
        about: [
          'Builds, runs in acdev runtime, and rebuilds and reloads what changed. One project: its desktop or app. '
            + 'Several projects or --desktop: all in that desktop (default: the desktop project among them, '
            + 'else dopame).',
        ],
        options: [
          { flag: '--headless', about: 'No host window (machines without a display, CI)' },
          {
            flag: '--verbose',
            about: 'Also the runtime\'s own info log (by default only what the pages and backends print, '
              + 'and the runtime\'s warnings and errors)',
          },
          { flag: '--app ID', about: 'With several apps in a project, the one to open' },
          { flag: '--desktop ID|DIR', about: 'Run the projects in that desktop' },
          { flag: '--out DIR', about: 'Where to build (default: .acde; one project only)' },
          { flag: '--force', about: 'Start even when another acdev dev runs the same project' },
          { flag: '--lock', about: 'Open the lock page of the desktop project alone, with a stand-in acde:lock (see the lock page checks)' },
          {
            flag: '--keep',
            about: 'Keep the folders that stand in for Documents, Downloads and the other shared places after the session '
              + '(by default they are removed)',
          },
        ],
        examples: ['acdev dev', 'acdev dev --headless', 'acdev dev ./app ./desk'],
      },
      {
        name: 'test',
        group: 'Develop',
        args: '[dir|file...]',
        summary: 'Run the end-to-end tests (*.e2e.ts)',
        about: [
          'Runs *.e2e.ts files (import from acdev/test); each test gets a fresh, isolated acdev dev, headless '
            + 'unless --headed. What a failing test left goes to <project>/.acde/test-results.',
        ],
        options: [
          { flag: '-t PATTERN', about: 'Only the tests whose names match' },
          { flag: '--headed', about: 'Show the windows (default: headless)' },
          { flag: '--desktop ID|DIR', about: 'Run the app in that desktop' },
          {
            flag: '--vm',
            about: 'Run in the logged-in session in the guest of acdev vm: one file at a time, every test in the same '
              + 'session; home is that user\'s HOME; the user\'s password is set to ACDEV_VM_PASSWORD (default '
              + 'dopame-dev) and faillock reset first',
          },
          { flag: '--timeout MS', about: 'Milliseconds per test (default: 60000)' },
          { flag: '--bail', about: 'Stop at the first failure' },
          { flag: '--workers N', about: 'Files at once (default: half the cores, at most 4; 1 headed or with --bail)' },
          { flag: '--retries N', about: 'Run a failing test again (passing later means flaky; default: 0)' },
          { flag: '--trace', about: 'A screenshot after every step and trace.html for every test' },
          { flag: '--video[=on]', about: 'An animated PNG of the screen of failing tests (=on: of every test)' },
          { flag: '-u, --update-screenshots', about: 'Rewrite the screenshot baselines' },
        ],
        examples: ['acdev test', 'acdev test e2e/notes.e2e.ts -t saves --headed'],
      },
      {
        name: 'doctor',
        group: 'Develop',
        args: '[dir]',
        summary: 'Check this machine for acdev dev and say how to fix it',
        about: [
          'Checks acdev on PATH, Bun and Node.js, acdev runtime (found, runs, pairs with this acdev, its own check of the '
            + 'GPU and its files), running sessions, the project in dir and the agent skill. Exit code 1 on an error.',
        ],
        options: [
          { flag: '--online', about: 'Also check whether a newer acdev is out' },
          { flag: '--json', about: 'Print one JSON object' },
          { flag: '--fix', about: 'Then fix what acdev may (the skill, .acde/ in .gitignore, the sessions directory)' },
          { flag: '--yes', about: 'With --fix, also do what downloads or stops something, without asking' },
        ],
        examples: ['acdev doctor', 'acdev doctor --fix'],
      },
      inspecting('webs', '', 'List the pages acdev runtime runs', ['The webs (windows\' pages) of the session, and the '
        + 'camera or microphone prompts that wait.'], [], ['acdev webs']),
      inspecting('inspect', '', 'Print the screen as text, with refs', [
        'The windows, then the elements of the focused window, one per line with a ref such as w1.12 that act takes.',
        'Exit code 2: --find found nothing.',
      ], [
        { flag: '--find TEXT', about: 'Only elements whose name or value contains TEXT' },
        { flag: '--window W', about: 'That window instead of the focused one' },
        { flag: '--all', about: 'Every window not marked [minimized], and elements hidden by opacity: 0' },
        { flag: '--offscreen', about: 'Also elements scrolled out of view' },
      ], ['acdev inspect', 'acdev inspect --find Save']),
      inspecting('query', '<selector>', 'Find elements by CSS selector', [
        'The elements a CSS selector matches in the focused window, each with a ref act takes; also what inspect '
          + 'leaves out (not rendered ones are marked [hidden]).',
        'Exit code 2: nothing matches.',
      ], [
        { flag: '--window W', about: 'That window instead of the focused one' },
        { flag: '--ref REF', about: 'Only under that element' },
        { flag: '--limit N', about: 'At most N elements, 1 to 3000 (default: 600)' },
      ], ['acdev query "button.primary"']),
      inspecting('act', '<ref> <action> [arg]', 'Click, type, press keys… on a ref', [
        'Performs one action on a ref from inspect or query and prints what changed.',
        `Actions: ${actions.filter((a) => !WINDOW_ACTIONS.includes(a)).join(', ')}. A window ref (w1) also takes `
          + `${WINDOW_ACTIONS.join(', ')}.`,
        'key takes key names separated by spaces (ctrl+a backspace); type and settext take text; drag takes the '
          + 'target ref; scroll takes pixels.',
        'Exit code 1: the action was not done, or the ref does not exist (acdev inspect --find gives current refs).',
      ], [], ['acdev act w1.12 click', 'acdev act w1.3 type "hello"', 'acdev act w1.3 key "ctrl+a backspace"']),
      inspecting('input', '<web> <events|->', 'Send raw mouse and keyboard events to a page', [
        'Sends a JSON array of events to a web (a web name, an app id or desktop), in its CSS pixels; - reads it from '
          + 'stdin. Events: {"type":"move","x":..,"y":..}, down / up (x, y, button: left | right | middle), wheel (x, y, '
          + 'dx, dy), keydown / keyup (key: "ArrowLeft", "Shift", "a"…), text (text), wait (ms, up to 10000).',
        'Moves are a frame apart, so a run of moves with the button down draws a path; keydown, wait, keyup holds a key.',
      ], [], [
        'acdev input game \'[{"type":"keydown","key":"ArrowRight"},{"type":"wait","ms":500},{"type":"keyup","key":"ArrowRight"}]\'',
        'acdev input paint \'[{"type":"move","x":10,"y":10},{"type":"down","x":10,"y":10},{"type":"move","x":60,"y":40},{"type":"up","x":60,"y":40}]\'',
      ]),
      inspecting('eval', '<web> <code|->', 'Evaluate JavaScript in a page', [
        'Runs code in a web (a web name, an app id or desktop) and prints the result as JSON; - reads the code '
          + 'from stdin.',
      ], [], ['acdev eval notes "document.title"']),
      inspecting('shot', '<web>', 'Take a PNG of a window', [
        'A PNG of the web\'s window; prints its path. The desktop\'s page has no panels it pinned (a Dock, '
          + 'a menu bar): take acdev screen to see them.',
      ],
        [{ flag: '-o, --output FILE', about: 'Where to write it (default: ./<web>.png)' }], ['acdev shot notes']),
      inspecting('screen', '', 'Take a PNG of the whole screen', ['A PNG of the whole screen, every window composed.'],
        [{ flag: '-o, --output FILE', about: 'Where to write it (default: ./screen.png)' }], ['acdev screen']),
      inspecting('console', '', 'Print the pages\' console output and errors', [
        'The pages\' console.* lines and uncaught errors.',
      ], [
        { flag: '--web W', about: 'Only that page' },
        { flag: '--level L', about: 'One of log, info, warn, error, debug, errors' },
        { flag: '--since S', about: 'From the last reload of acdev dev (reload) or from entry N on (N)' },
        { flag: '--follow', about: 'Keep printing new entries' },
      ], ['acdev console --level errors']),
      inspecting('network', '', 'Print the pages\' requests', [
        'The pages\' fetch / XHR / WebSocket / EventSource requests and the images, stylesheets and fonts they '
          + 'load, and how they ended.',
      ], [
        { flag: '--web W', about: 'Only that page' },
        { flag: '--failed', about: 'Only failed requests and status 400 or more' },
        { flag: '--since S', about: 'As for console: reload, or N' },
        { flag: '--follow', about: 'Keep printing new requests' },
      ], ['acdev network --failed']),
      inspecting('pointer', '<x> <y>', 'Move the pointer to a screen point', [
        'Moves the pointer as a real move (hover, screen edges); in a host window the screen is its content area.',
      ], [], ['acdev pointer 0 0']),
      inspecting('choose', '<folder|open|save> [path...]', 'Answer the next file picker', [
        'Answers the next picker of that kind the page opens: folder (one folder), open (one or more files) or save '
          + '(the file to write). A headless session shows no picker, so answer it before the action that opens it; in '
          + 'a window the answer also takes the place of the dialog. Relative paths are from the current directory.',
      ], [{ flag: '--cancel', about: 'Answer the picker as cancelled' }],
      ['acdev choose folder ~/Notes', 'acdev choose open a.md b.md', 'acdev choose save out/report.md', 'acdev choose open --cancel']),
      inspecting('drop', '<web> <file...>', 'Drop files onto a page', [
        'Drops files onto a web (a web name, an app id or desktop) as a drag from the system would: the page gets '
          + 'dragenter, dragover and drop with the files. Relative paths are from the current directory.',
      ], [{ flag: '--at X,Y', about: 'Where, in the page\'s CSS pixels (default: the middle of the page)' }],
      ['acdev drop notes notes/today.md', 'acdev drop notes a.png --at 120,300']),
      inspecting('permissions', '', 'List camera and microphone prompts', [
        'The camera and microphone prompts that wait and the decisions made (other capabilities are granted '
          + 'when declared).',
      ], [], ['acdev permissions']),
      inspecting('allow', '[<prompt>|<app> <capability>]', 'Allow a waiting prompt', [
        'Allows the only waiting prompt, the one with that id (acdev permissions shows it), or the one of that app '
          + 'for that capability.',
      ], [{ flag: '--all', about: 'Every waiting prompt' }], ['acdev allow', 'acdev allow recorder microphone']),
      inspecting('deny', '[<prompt>|<app> <capability>]', 'Deny a waiting prompt', [
        'Denies the only waiting prompt, the one with that id, or the one of that app for that capability.',
      ], [{ flag: '--all', about: 'Every waiting prompt' }], ['acdev deny']),
      inspecting('revoke', '<app> <capability>', 'Take back a decision', ['Takes back a decision, so the app is asked '
        + 'again.'], [], ['acdev revoke recorder microphone']),
      inspecting('stop', '', 'End the session', [
        'Ends the acdev dev and its acdev runtime, as closing its last window does; for one started in the background.',
      ], [], ['acdev stop']),
      inspecting('devtools', '[web]', 'Open DevTools on a page', [
        'Opens the DevTools of Chrome or Edge on a page of the session: web (a web name, an app id, desktop, '
          + 'a window title, or services or a service name for the services), else the focused page. Prints the '
          + 'DevTools address; without Chrome or Edge it prints only the address to paste into one. ACDEV_BROWSER '
          + 'names the browser to use; none opens nothing. F12 in a window of acdev dev does the same for the page '
          + 'in that window (fn+F12 on a Mac keyboard), and brings its DevTools to the front when they are open.',
      ], [], ['acdev devtools', 'acdev devtools notes', 'acdev devtools services']),
      {
        name: 'mcp',
        group: 'Agents',
        args: '',
        summary: 'Serve the session tools over MCP (stdio)',
        about: ['An MCP server on stdio with the session tools, and start / logs to run acdev dev itself.'],
        options: [SESSION],
        examples: ['claude mcp add acdev -- acdev mcp'],
      },
      {
        name: 'skills',
        group: 'Agents',
        args: '[install|remove|path]',
        summary: 'Install the acdev skill for coding agents',
        about: [
          'The acdev skill (how to build, run, inspect and test with acde, in the Agent Skills format): where it '
            + 'is installed; install links it into ~/.agents/skills and the skills directory of every agent found '
            + 'here; remove takes it away; path prints its directory.',
        ],
        options: [
          { flag: '--agent ID,...', about: 'Only for those agents' },
          { flag: '--dir DIR', about: 'Into DIR' },
          { flag: '--copy', about: 'A copy, not a link' },
        ],
        examples: ['acdev skills install'],
      },
      {
        name: 'vm',
        group: 'Emulator',
        args: '<subcommand> [args]',
        summary: 'Run a Dopame OS guest under QEMU (KVM, WHPX or HVF)',
        about: [
          'fetch downloads the newest Dopame OS x86_64 disk image. start boots it in the background under an overlay '
            + 'disk (the image stays as it is) and waits until the guest is ready; stop powers it off; status, wait. '
            + 'screenshot FILE.png takes the guest screen. start also puts acdevd, the device daemon, in the guest; '
            + 'over vsock (Linux) or a forwarded port (elsewhere), with a fresh key each start, '
            + 'run COMMAND runs a command as root in the guest, streams its output and exits with its code '
            + '(--detach: in the background, its output in a log; kill PID stops it); shell [COMMAND] opens an '
            + 'interactive terminal (a pty that follows the window size; exits with its code); logs [SOURCE] shows the '
            + 'journal, a systemd unit, a guest file or a --detach program\'s log (--follow, --grep); dev [DIR] builds the '
            + 'Cargo project in DIR on the host (its guest profile when it has one), pushes its binaries to /opt/acdev/bin, runs them and shows their output, '
            + 'then builds, pushes and restarts again whenever a source file changes; push LOCAL [REMOTE] copies a file '
            + 'or directory in (default /opt/acdev/<name>); pull REMOTE [LOCAL] copies a guest file or directory out '
            + '(default ./<name>; into LOCAL/<name> when LOCAL is a directory); '
            + 'view opens acdev\'s own window again on a guest started with --viewer; '
            + 'mount mounts the --share directory at /mnt/acdev; console makes the guest kernel log to the serial '
            + 'port from the next boot; usb add IMAGE [--size SIZE] plugs a disk image in as a USB stick (a new image is made '
            + 'and formatted FAT, which needs mkfs.vfat or mkfs.exfat), usb remove [IMAGE or ID] pulls it (default: the last one), '
            + 'usb list shows them; wake wakes a guest that went to sleep (S3); '
            + 'provision sets the guest up for testing (the user, its password, greetd on the acdes '
            + 'login screen, acdes and winman laid out by the acdes PKGBUILD, the Dopame package) and can be run again.',
          'The images, the overlay disk, the sockets and the logs live in $ACDEV_VM_DIR (default '
            + '~/.local/share/acdev/vm). Needs qemu-system-x86_64, qemu-img and UEFI firmware (ACDEV_QEMU_DIR); without KVM, WHPX or HVF it emulates.',
        ],
        options: [
          { flag: '--headless', about: 'start: no window (screenshots still work)' },
          { flag: '--vnc', about: 'start: a VNC display on 127.0.0.1:5900 instead of a window' },
          {
            flag: '--outputs N',
            about: 'start: N displays (virtio-vga max_outputs, 1 to 16); with a window it is GTK, one tab each (SDL cannot show '
              + 'displays 1 and up)',
          },
          { flag: '--output N', about: 'screenshot: which display, from 0 (default 0)' },
          { flag: '--viewer', about: 'start: show the guest in acdev\'s own window (QEMU\'s D-Bus display; Linux for now)' },
          {
            flag: '--sdl',
            about: 'start: QEMU\'s SDL window, the default window on Linux: the guest starts at 1280x800 and follows the window '
              + 'when you resize it (needs QEMU built with SDL; without it the default falls back to GTK)',
          },
          {
            flag: '--gtk',
            about: 'start: QEMU\'s GTK window instead (Linux): GTK hands its first, small window size to the guest as the preferred '
              + 'resolution, so the guest starts small until you enlarge the window',
          },
          { flag: '--share DIR', about: 'start: export DIR to the guest over 9p (then acdev vm mount)' },
          { flag: '--image FILE', about: 'start: the base disk image (default: the newest fetched)' },
          { flag: '--fresh', about: 'start: drop the guest\'s changes (overlay disk, UEFI variables) first; run provision again after it' },
          { flag: '--acdes DIR', about: 'provision: the acdes checkout (its PKGBUILD lays acdes out), with --acdes-bin and --winman-bin' },
          { flag: '--acdes-bin FILE', about: 'provision: the acdes guest build' },
          { flag: '--winman-bin FILE', about: 'provision: the winman guest build' },
          { flag: '--libacde DIR', about: 'provision: the libacde checkout (only its LICENSE)' },
          { flag: '--dopame DIR', about: 'provision: the dopame checkout, built (packages/dopame/dist)' },
          { flag: '--harness FILE', about: 'provision: the dopame-harness build' },
          { flag: '--user NAME', about: 'provision: the test user (default tester; password ACDEV_VM_PASSWORD, default dopame-dev)' },
          { flag: '--no-restart', about: 'provision: leave greetd running as it is' },
          { flag: '--no-wifi', about: 'provision: no simulated Wi-Fi (by default acdev-wifi.service starts two access points over mac80211_hwsim)' },
          { flag: '--no-bluetooth', about: 'provision: no simulated Bluetooth (by default acdev-bt.service starts virtual controllers through btvirt)' },
          { flag: '--btvirt FILE', about: 'provision: a btvirt build (BlueZ emulator/btvirt) for the guest; without it provision builds one in the guest' },
          { flag: '--no-battery', about: 'provision: no simulated battery (by default acdev-battery.service sets a test_power battery to 100%, charging)' },
          { flag: '--wifi, --bluetooth, --battery', about: 'provision: deprecated, change nothing (all three are on by default)' },
          { flag: '--wait SECONDS', about: 'start: how long to wait until the guest is ready (default 300; 0: not)' },
          { flag: '--audio none|wav', about: 'start: where the guest sound card plays: nowhere (default) or <logs>/audio.wav' },
          { flag: '--size SIZE', about: 'usb add: the size of a new image, like 256M or 2G (default 256M)' },
          { flag: '--gl', about: 'start: virtio-vga-gl with an OpenGL window (virgl; not on the roadmap)' },
          { flag: '--detach', about: 'run: in the background; prints its process group id' },
          { flag: '--force', about: 'kill: SIGKILL instead of SIGTERM' },
          { flag: '--follow', about: 'logs: keep showing new lines until Ctrl+C' },
          { flag: '--grep REGEX', about: 'logs: only the lines that match (ignoring case)' },
          { flag: '--lines N', about: 'logs: how many earlier lines first (default 50)' },
          { flag: '--bin A,B', about: 'dev: only these binaries of the project (default: all)' },
          { flag: '--run COMMAND', about: 'dev: what to run in the guest, with /opt/acdev/bin on PATH (default: the first binary)' },
          { flag: '--profile NAME', about: 'dev: the cargo profile (default: guest when the project has one, else release)' },
        ],
        examples: [
          'acdev vm fetch', 'acdev vm start --headless --share target/release', 'acdev vm run -- uname -a', 'acdev vm shell',
          'acdev vm logs 1234 --follow --grep error',
          "acdev vm dev ../winman --run 'systemctl stop greetd; winman --card /dev/dri/card1 winman-test-client'",
          'acdev vm screenshot screen.png', 'acdev vm stop',
        ],
      },
    ]
  }

  static width(columns: number | undefined = process.stdout.columns): number {
    return columns ? Math.max(Help.MIN, Math.min(Help.MAX, columns)) : Help.WIDTH
  }

  static terminal(stream: { readonly isTTY?: boolean; readonly columns?: number } = process.stdout): number | null {
    return stream.isTTY ? Help.width(stream.columns) : null
  }

  static block(text: string | readonly string[], width: number | null, indent: string, first = indent): string[] {
    if (width === null) return [first + (typeof text === 'string' ? text : text.join(' '))]
    const [head = '', ...rest] = Help.wrap(text, width, indent)
    return [first + head.slice(indent.length), ...rest]
  }

  static wrap(text: string | readonly string[], width: number, indent: string): string[] {
    const lines: string[] = []
    let line = ''
    for (const word of typeof text === 'string' ? Help.words(text) : text) {
      if (line && Color.width(line) + 1 + Color.width(word) > width - indent.length) {
        lines.push(indent + line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(indent + line)
    return lines
  }

  static words(text: string): string[] {
    return text.split(/\s+/).filter(Boolean)
  }

  static unbroken(text: string): string[] {
    const tokens: string[] = []
    let previous = ''
    for (const word of Help.words(text)) {
      if (tokens.length && /[\\/]/.test(previous)) tokens[tokens.length - 1] += ` ${word}`
      else tokens.push(word)
      previous = word
    }
    return tokens
  }

  static overview(
    commands: readonly HelpCommand[], version: string, c: Palette = Color.palette(), width = Help.width(),
  ): string {
    const pad = Math.max(...commands.map((command) => command.name.length)) + 2
    const indent = ' '.repeat(pad + 2)
    const out = [`acdev ${version}: build, run and test apps for Dopame`, '']
    out.push(`${c.heading('Usage:')} acdev <command> [options]`)
    for (const group of Help.GROUPS) {
      out.push('', c.heading(`${group}:`))
      for (const command of commands.filter((item) => item.group === group))
        out.push(...Help.block(command.summary, width, indent, `  ${c.name(command.name.padEnd(pad))}`))
    }
    const options = [
      ['-h, --help', 'Print this help; after a command (acdev new --help), print that command\'s help'],
      ['-v, --version', 'Print the versions of acde, the SDK and the acdev runtime it finds'],
    ] as const
    const flags = ' '.repeat(17)
    out.push('', c.heading('Options:'))
    for (const [flag, about] of options) out.push(...Help.block(about, width, flags, `  ${c.option(flag.padEnd(15))}`))
    const more = `Run ${c.name('acdev <command> --help')} for a command's options and examples.`
    out.push('', ...Help.wrap(more, width, ''))
    return out.join('\n')
  }

  static command(command: HelpCommand, c: Palette = Color.palette(), width = Help.width()): string {
    const usage = ['acdev', command.name, command.args, command.options.length ? '[options]' : '']
      .filter(Boolean).join(' ')
    const out = [`${c.heading('Usage:')} ${usage}`, '']
    for (const paragraph of command.about) out.push(...Help.wrap(paragraph, width, ''))
    if (command.options.length) {
      const pad = Math.min(26, Math.max(...command.options.map((option) => option.flag.length)) + 2)
      out.push('', c.heading('Options:'))
      for (const option of command.options) {
        const first = option.flag.length + 2 > pad
        const [head = '', ...rest] = Help.wrap(option.about, width, ' '.repeat(pad + 2))
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
