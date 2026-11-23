# Debugging

A set of commands connects to a running `acdev dev` session and lets you look at pages, run code, take screenshots, and click buttons. `acdev devtools` also opens the DevTools of Chrome or Edge on a page; see [DevTools](#devtools). Run them in another terminal:

```sh
acdev webs
```

```text
NAME           KIND     APP    WINDOW   TITLE
desktop        desktop  -      0        My Desktop
notes#1048576  app      notes  1048576  Notes
```

## Sessions

These commands find an `acdev dev` session in this order: `--session <pid>`; otherwise the session whose project directory contains the current directory; otherwise, outside any project, the only session, if there is just one (the command then names it on stderr: `acdev: using acdev dev <pid> (...), the only one running`); otherwise they fail and list all sessions. Sessions that `acdev test` started for its tests are left out of this choice (they are listed with `acdev test` after what they run); only `--session <pid>` reaches them.

## Commands

| Command | What it does |
| --- | --- |
| `acdev webs` | Lists the running pages (one per window) |
| `acdev eval <web> <code>` | Runs code in a page and prints the result as JSON; Promises are awaited. With `-` as the code, reads it from stdin |
| `acdev shot <web> [-o FILE]` | Screenshot of one window's page (PNG); for `desktop`, without the panels it pins (Dock, menu bar), which `acdev screen` shows |
| `acdev screen [-o FILE]` | Screenshot of the whole screen, all windows together |
| `acdev shot <web> --ref REF`, `acdev screen --ref REF` | Only one element (a ref from `inspect`, like `w1.12`) or window (`w1`): the whole window or screen is taken and cut at its rectangle, at the picture's device-pixel scale. An element scrolled out of view or gone is an error; scroll it into view first |
| `acdev shot <web> --rect X,Y,W,H`, `acdev screen --rect X,Y,W,H` | Only that area, in logical pixels (from the window's top left for `shot`, of the screen for `screen`); an area that reaches past the edge is an error |
| `acdev appearance [--dark \| --light] [--glass-level N] [--reduced-transparency on\|off]` | Without options prints dark or light, the glass level (0 clear, 1 medium, 2 tinted) and reduced transparency; with them sets them and prints the result. With `--session vm` it changes the guest's system setting, as the Settings app does: the desktop, its apps and the lock page follow (the login page follows the time of day), so a test can switch to dark, take `acdev screen`, and switch back. In a host session it changes only this session's pages (`prefers-color-scheme`, the glass and `prefers-reduced-transparency`); a later change of the host's own glass setting takes the glass back |
| `acdev open <app\|path\|url> [path\|url]` | Opens like the desktop does (`acde:open`): `acdev open files` starts an app; `acdev open /home/tester/Documents/a/b` opens a deep folder or file with its default app; `acdev open files /home/tester/Documents/a` with the app named first; `acdev open https://example.com` a link (http and https only). A word is an app, anything with a `/` (`./notes.md`) a path. With `--session vm` paths are the guest's and absolute; on the host a relative path is from the current directory. A single-app session has only its own app, which gets the file or link as an `open-file` or `open-link` request. Prints what happened; exits 1 when it could not |
| `acdev pointer <x> <y>` | Moves the pointer to a point on the screen, as a real move: hover effects and screen edge events (a desktop showing its Dock at an edge) follow. In a host window the screen is its content area |
| `acdev inspect [--window W] [--find TEXT] [--all] [--offscreen]` | Turns the screen into text: the window list and the element tree of the focused window (`--all`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`) |
| `acdev query <selector> [--window W] [--ref REF] [--limit N]` | Finds elements by CSS selector, including ones `inspect` leaves out, and prints a ref for each |
| `acdev act <ref> <action> [arg]` | Clicks, types, presses keys, and more on a ref from `inspect` or `query` |
| `acdev console [--web W] [--level L] [--since S] [--follow]` | The pages' `console.*` output and uncaught errors |
| `acdev network [--web W] [--failed] [--since S] [--follow]` | The pages' fetch / XHR / WebSocket / EventSource requests and their image, stylesheet and font loads; the kind column says which |
| `acdev permissions` | Lists the camera and microphone prompts that wait and the decisions made; see [Camera and microphone](#camera-and-microphone) |
| `acdev allow` / `acdev deny` `[<prompt id> \| <app> <capability>] [--all]` | Answers a waiting camera or microphone prompt |
| `acdev revoke <app> <capability>` | Takes back a decision |
| `acdev stop` | Ends the session; see [Stopping](dev.md#stopping) |
| `acdev devtools [web]` | Opens the DevTools of Chrome or Edge on a page; see [DevTools](#devtools) |

A **web** is one page: the desktop page, or the page in one app window (each window has one). `<web>` is a web name from `acdev webs` (`notes#1048576`), an app id (that app's first window), or `desktop`. In a Dopame OS guest, a page that does not answer within 1.5 s (its process is stopped or busy) is still listed, with the title `(not answering)`; the other pages are listed as usual.

### eval

```sh
acdev eval notes 'document.title'
acdev eval notes 'import("acde:fs").then(m => m.fs.roots())'
echo 'localStorage.length' | acdev eval notes -
```

On Windows, `acdev` is `acde.cmd`, so what reaches the CLI is what cmd makes of the arguments. What a shell passes differs:

- PowerShell (5.1 and 7) drops double quotes inside arguments it passes to a `.cmd`; write them as `\"` (the first line below).
- cmd has no single-quoted strings: put the argument in double quotes and write the double quotes inside it as `\"` (the second line below).

```powershell
acdev eval notes 'document.querySelector(\"#x\").textContent'
```

```bat
acdev eval notes "document.querySelector(\"#x\").textContent"
```

Code that has only single quotes inside it is written the same way in all three, and passing the code on stdin avoids the question (shown for PowerShell):

```powershell
acdev eval notes "document.querySelector('#x').textContent"
'document.querySelector("#x").textContent' | acdev eval notes -
```

The same applies to any argument with double quotes, such as `act ... type`.

### inspect and act

`inspect` gives every element a **ref**, such as `w1.18` (element 18 in window `w1`); pass it to `act`.

```sh
$ acdev inspect
- window "Notes" [app=notes] [focused] [fullscreen] [w1]
  - heading "Notes" [level=1] [w1.16]
  - form [w1.6]
    - text "Title" [w1.17]
    - textbox "Title": "" [w1.18]
    - text "Email" [w1.19]
    - textbox "Email": "" [w1.20]
    - button "Save" [w1.21]
  - list "Saved notes" [w1.7]
    - listitem [w1.22]
      - text "Buy milk" [w1.22]
  - text "1 note" [w1.8]
  (1 more outside the visible area; scroll, or add offscreen)

$ acdev act w1.18 type "Weekly report"
typed, the value is now "Weekly report"

(windows unchanged)
- window "Notes" [app=notes] [focused] [fullscreen] [w1]
  ~ - textbox "Title": "Weekly report" [focused] [w1.18]
  (1 more outside the visible area; scroll, or add offscreen)

$ acdev act w1.21 click
clicked 55,202

(windows unchanged)
- window "Notes" [app=notes] [focused] [fullscreen] [w1]
  ~ - textbox "Title": "" [w1.18]
  ~ - button "Save" [focused] [w1.21]
  + - listitem [w1.23]
  + - text "Weekly report" [w1.23]
  ~ - text "2 notes" [w1.8]
  (1 more outside the visible area; scroll, or add offscreen)
```

Without `--find`, the text is always in this English format: one line per window, top first (`- window "Notes" [app=notes] [focused] [w1]`, the desktop is `- desktop`), and under a listed window its elements, indented two spaces per level, as `- role "name": "value" [states] [ref]` (the value only where the element has one). Notes in parentheses say what is left out or unchanged, such as `(empty)`, `(no changes)` and `(windows unchanged)`.

`act` prints what it did on the first line (`clicked 55,202` is the point it clicked, in window coordinates), waits for the page to settle, and then prints the windows and the content of the window again. Where it has listed that window before, it prints only what changed since: `~` for a changed line, `+` for a new one, `-` for one that is gone; `(windows unchanged)` stands for an unchanged window list. So the output of `act` is usually all you need to read before the next step. An element that is scrolled out of view is scrolled into view first, so a ref from `inspect --offscreen` or `query` works wherever the element is on the page.

`act` exits with code 0 when the action was done. When it was not, it prints one line on stderr, `acdev: act <ref>: <reason>`, and exits with code 1. The reasons: `the element is not displayed` (it is `display: none` or hidden by `visibility`), `covered by another element: <div> (27)`, `cannot type into this element`, `there is no such element (any more); acdev inspect --find TEXT gives the current refs` (the element is gone, see below), `w1 is minimized; act restore on it first` (a click or another pointer action on a minimized window or on an element in it).

A ref stays the same as long as its element lives: moving it, changing its text or attributes, or reordering a list keeps it. When the page replaces the element with a new one (for example by setting `innerHTML`), the new element gets a new ref, and acting on the old one fails (`acdev: act w1.23: there is no such element (any more); …`); take a new `inspect` then.

An app run on its own shows its window menus on the title bar (see [Windows](window.md#menus)), and `inspect` lists them first: `menubar [w1.m]`, one `menuitem "File" [collapsed] [w1.m1]` per menu, and under the open one its items with their shortcuts, `menuitem "New": "ctrl+n" [w1.m1.1]` (a separator takes a number too). `acdev act w1.m1 click` opens a menu, `acdev act w1.m1.1 click` opens it if needed and chooses the item (`chose File › New`), and `acdev act w1 key escape` closes it. A disabled item is not chosen (`acdev: act w1.m1.4: w1.m1.4 (Print) is disabled`).

By default the tree leaves out elements that can't be seen: `display: none`, `aria-hidden`, `inert`, `opacity: 0` and hidden `visibility`. `--all` lists every window that is not marked `[minimized]` in the window list and also keeps the elements hidden by `opacity: 0` (marked `transparent`; they can still be clicked) or by `visibility` (marked `invisible`; they can't); `display: none`, `aria-hidden` and `inert` are always left out.

A window that is off the screen is marked `[minimized]` in the window list: one whose state is `minimized` (after `act w1 minimize`, the app's own `minimize()`, or the desktop's `windows.requestState(id, 'minimized')`), and one the desktop hid with `windows.hide(id)`. Its elements are not listed: `--all` and `--find` skip it, and `--window w1` prints `(empty)` and `(minimized; act restore on it to see its elements)` under its line. Pointer actions on it (`click`, `double`, `right`, `hover`, `scroll`, and `drag` from or onto it) are refused, and `act w1 restore` brings it back. In a desktop session:

```sh
$ acdev act w1 minimize
w1 is minimized (the windows changed)

- window "Tools" [app=tools] [minimized] [w1]
- desktop [focused] [fullscreen] [w0]
  - navigation "Apps" [w0.6]
    - button "Tools" [w0.10]

$ acdev act w1.10 click
acdev: act w1.10: w1 is minimized; act restore on it first

$ acdev act w1 restore
w1 is in front (the windows changed)

- window "Tools" [app=tools] [focused] [w1]
  + - heading "Tools" [level=1] [w1.10]
- desktop [fullscreen] [w0]
```

`--find TEXT` looks in every window that is not marked `[minimized]` (or in `--window W`) and prints only the elements whose name or value contains the text (case does not matter). Its output has a format of its own: a line `<window ref> <app id> "<title>":` for each window that has a match (`w0 desktop:` for the desktop), and under it one line per element. An element inside an ancestor that has a name is followed by `in` and the nearest such ancestor; one that has none is followed by nothing:

```sh
$ acdev inspect --find milk
w1 notes "Notes":
- text "Buy milk" [w1.22]  in list "Saved notes" [w1.7]

$ acdev inspect --find save
w1 notes "Notes":
- button "Save" [w1.21]
- list "Saved notes" [w1.7]
```

When nothing matches it says so on stderr (`acdev: no element's name or value contains "milk"; elements scrolled out of view need --offscreen`) and exits with code 2. Elements scrolled out of view are found only with `--offscreen`; without it, a note under the tree says how many were left out (`(1 more outside the visible area; scroll, or add offscreen)`).

Actions: `click` `double` `right` `hover` `scroll` `type` `settext` `select` `key` `drag` `focus`; a window ref (`w1`) also accepts `close` `minimize` `restore` `fill` `fullscreen` `move` `resize` `raise`. `move` takes screen `x,y` in logical pixels (`acdev act w1 move 100,80`) and keeps the size; `resize` takes `WxH` (`acdev act w1 resize 800x600`) and keeps the place; both print the window's new rectangle (`w1 is at 100,80 800x600`), and when the app takes the new size late, acdev waits up to 2 seconds and then says it has not taken it yet. `raise` brings the window to the front. Only a window in the normal state moves or resizes: the desktop, a minimized, filled or full-screen window, a pinned panel and the window of a single-app session are refused with the reason (`w1 is filled; only a normal window can resize: act w1 restore first`). `drag` acts like a hand: it presses, holds 150 ms, moves in 10 steps a frame apart and rests a frame before letting go; to put a window at an exact place use `move`, not a drag of its title bar. `fill` fills the desktop's work area with the window and `fullscreen` covers the whole host window with it; `restore` sets either back to normal. Both refuse the desktop (`the desktop cannot be made filled`, `... fullscreen`) and a window that already fills the host window (`w1 already fills the host window`). `minimize` on a window that cannot be minimized changes nothing, says why and exits with code 1; in a session that runs a single app, on macOS and headless, that is the app's own window: `w1 cannot be minimized: it fills the host window, which only the host window's own controls minimize here`. The argument to `key` looks like `"ctrl+a backspace"`; the argument to `drag` is the target ref. When closing a window ends acdev runtime (the app's window when `acdev dev` runs one app), `acdev dev` ends with it; `act w1 close` then says so and exits with code 0.

#### Key names

The argument to `key` (and `press()` in tests) is one or more chords separated by spaces; a chord is keys joined by `+`, pressed in order and released in reverse. Keys are physical keys on a US layout. Case does not matter, except that a single capital letter (`A`) adds `shift`:

- modifiers: `ctrl` (`control`), `shift`, `alt`, `super` (`meta`, `win`)
- letters `a` … `z`, digits `0` … `9`, `f1` … `f12`
- `enter` (`return`), `escape` (`esc`), `tab`, `space`, `backspace`, `delete` (`del`), `insert`, `home`, `end`, `pageup`, `pagedown`, `up`, `down`, `left`, `right`, `menu`
- printable characters as they are: `-` `=` `[` `]` `;` `'` `` ` `` `\` `,` `.` `/`, and the shifted ones `!` `@` `#` `$` `%` `^` `&` `*` `(` `)` `_` `+` `{` `}` `|` `:` `"` `<` `>` `?` `~`, which add `shift` themselves (`*` is `shift+8`). `+` alone, or last in a chord (`ctrl++`), is the `+` key
- names for some characters: `plus` (`+`), `multiply`, `asterisk`, `star` (`*`), `minus` (`-`), `divide` (`/`), `period` (`.`), `comma` (`,`); these are the main keyboard keys, not the keypad
- the keypad: `Numpad0` … `Numpad9`, `NumpadAdd`, `NumpadSubtract`, `NumpadMultiply`, `NumpadDivide`, `NumpadDecimal`, `NumpadEnter`
- the DOM `KeyboardEvent.code` names of the other keys, e.g. `KeyA`, `Digit8`, `Minus`, `ArrowUp`, `CapsLock`, `ShiftRight`

The whole argument is checked before anything is pressed: an unknown key fails with `unknown key: …` and presses nothing. The space character is `space` (spaces separate chords). To enter text, use `type` instead.

### query

`inspect` lists what a user can see and use. `query` finds elements by CSS selector whether they are shown or not, and gives each a ref, so it reaches what `inspect` leaves out: an element that is `display: none`, one that is scrolled out of view, and one that has no role, name or value of its own (a plain `<div>`; `inspect` lists what is inside it in its place).

```sh
$ acdev query 'form input[type=email]'
1 in w1:
- textbox "Email": "" [w1.20] <input>

$ acdev query '[data-testid="menu"] li'
2 in w1:
- generic "Rename" [w1.25] <li> [hidden]
- generic "Delete" [w1.26] <li> [hidden]

$ acdev query button
4 in w1:
- button "Save" [focused] [w1.21] <button>
- button "Undo" [transparent] [w1.10] <button> [hidden]
- button [invisible] [w1.24] <button> [hidden]
- button "Load more" [w1.11] <button>

$ acdev query nav
acdev: nothing in w1 matches "nav"
```

Each line is the element's role, name, value, a heading's level, states and ref, exactly as `inspect` prints them (`- heading "Notes" [level=1] [w1.16] <h1>`), then its tag. `[hidden]` after the tag marks an element that is not visible: it has no size, or is `display: none`, hidden by `visibility`, or transparent, or its window is minimized. The `transparent` and `invisible` marks are the ones `inspect --all` gives: a transparent element still takes clicks, as it does for a user; for an `invisible` or `display: none` one, `act` answers `the element is not displayed` until the page shows it. An element whose role cannot be told is listed as `generic`; the tag says what it is.

The refs work with `act`, like the ones from `inspect`: `acdev act w1.20 type "me@example.com"`. `query` searches the focused window; `--window w2` picks another, `--ref w1.6` searches only under that element, and `--limit N` lists at most N elements (1 to 3000, default 600; the first line still counts them all). When nothing matches, it says so on stderr (`acdev: nothing in w1 matches "nav"`) and the exit code is 2; otherwise it is 0.

### Styles and layout

To look at styles and boxes, ask the page with `eval` (or the Elements panel of [DevTools](#devtools)). `getComputedStyle` gives the values the page uses after the CSS cascade, and `getBoundingClientRect` gives an element's box in CSS pixels of the page:

```sh
acdev eval notes "getComputedStyle(document.querySelector('h1')).color"
acdev eval notes "(({ display, fontSize, margin }) => ({ display, fontSize, margin }))(getComputedStyle(document.querySelector('.card')))"
acdev eval notes "(({ x, y, width, height }) => ({ x, y, width, height }))(document.querySelector('.card').getBoundingClientRect())"
```

Copy the properties you want into a plain object, as above, so the JSON result has them. The code has only single quotes inside, so it is written the same way in sh, PowerShell and cmd (see [eval](#eval)). To see whether something is drawn where you expect, take a screenshot with `acdev shot`; to find an element that `inspect` leaves out (no size, `display: none`), use `acdev query`.

### console and network

```sh
acdev console --level errors --follow
acdev network --failed
```

`--level` is `log`, `info`, `warn`, `error`, `debug`, or `errors` (`console.error` plus uncaught errors). `--follow` keeps printing new entries.

When a `fetch` in the page rejects with `TypeError: Failed to fetch`, the line of that request in `acdev network --failed` says why (a CORS rule, a name that does not resolve, a refused connection):

```sh
$ acdev network --failed
   1 GET    ERR https://nonexistent.invalid/  (fetch 158 ms; Failed to connect to host: Failed resolving hostname: failed to lookup address information: nodename nor servname provided, or not known) notes#1048576
```

Entries stay after a page reloads, so errors from before a change are still listed. The first column is the entry's number. `--since reload` lists only what came after `acdev dev` last rebuilt and reloaded (everything, if it has not reloaded yet); `--since N` lists entry `N` and later. A reload the page does by itself (`location.reload()`) does not count.

```sh
acdev console --level errors --since reload
```

The most recent 5000 entries of each kind are kept.

## DevTools

`acdev devtools [web]` opens the DevTools of Chrome or Edge (or Chromium on Linux) on a page of the session: Elements, Console, Network, and Sources with breakpoints.

```sh
acdev devtools            # the focused page
acdev devtools notes      # a web name, an app id, desktop, or a window title
acdev devtools services   # the desktop's services (or one service, by its name)
```

It prints the DevTools address on stdout, and on stderr `acdev: opened DevTools for <page> in <browser>`. Asked again for a page whose DevTools are open, it brings them to the front instead (`acdev: brought DevTools for <page> to the front in <browser>`). F12 in the host window of `acdev dev` does the same for the page in that window; see [acdev dev](dev.md#devtools).

The browser runs with a profile of acdev's own, not your everyday one. `ACDEV_BROWSER` names another browser (a path to it). Without Chrome or Edge, or with `ACDEV_BROWSER=none`, nothing opens: paste the printed address into the address bar of Chrome or Edge on this machine.

Elements shows the element tree, the computed styles and the box model, read only. It does not list the CSS rules that matched an element (only its inline style); change styles from the page code or the Console.

## Without a display

On a machine without a display, such as a server over ssh, start the session with `acdev dev --headless`. On Linux, `acdev dev` without it stops at once when neither `WAYLAND_DISPLAY` nor `DISPLAY` is set and says to add `--headless`; see [acdev dev](dev.md). Every command on this page works the same in a headless session:

```sh
acdev dev --headless &
acdev inspect          # the windows and the focused window's elements, as text
acdev shot notes       # ./notes.png
acdev screen           # ./screen.png, every window together
```

A headless session has no picker dialogs: a folder, file or save picker the page opens fails unless it was answered beforehand, and the page sees it as cancelled. Answer it from a test with `chooseFolder`, `chooseFiles` or `chooseSaveFile` ([Testing](testing.md#network-file-pickers-clipboard)), from an agent with the MCP tools `choose_folder`, `choose_files` and `choose_save_file` ([MCP](mcp.md)), or from the shell with `acdev choose folder ~/Notes`, `acdev choose open a.md b.md` or `acdev choose save out.md` (`--cancel` to cancel). `acdev drop <web> <file...>` drops files onto a page, as a drag from the file manager would. The session output names the missing answer: `no folder chooser without a host window (ACDE_HEADLESS): answer it beforehand with the MCP tool choose_folder or acde.chooseFolder() in a test`. A headless session also has its own clipboard and no camera or microphone dialog (see below).

## Camera and microphone

A capability an app declares is granted without asking, except the camera, the microphone and idle detection (`idleDetection`). The user is asked the first time a page asks for one (`getUserMedia`, `IdleDetector.requestPermission()`), and the call waits for the answer. In a session that runs a single app, the host window asks in a dialog on Windows, on macOS (a sheet with `Don't Allow` and `Allow`) and on Linux (a notification with the same two buttons, where the desktop's notification service shows buttons). Elsewhere, and in a headless session, there is no dialog, so answer from the command line:

```sh
$ acdev permissions
pending:
  1  recorder  microphone  (request)
decisions: none

$ acdev allow
allowed recorder microphone (prompt 1)
```

Without arguments, `acdev allow` and `acdev deny` answer the only waiting prompt. When several wait, they answer none and list them; name one by its id (`acdev allow 2`) or by app and capability (`acdev allow recorder microphone`), or answer them all with `--all`.

Decisions persist per app (in `$XDG_CONFIG_HOME/acde/permissions.json`), so the user is not asked again. Answering is the user's decision: when you run these commands for someone, allow only what they asked for or agreed to, and tell them what you allowed. `acdev revoke <app> <capability>` removes a decision, so the app is asked again the next time it asks. A denied or revoked capability makes `getUserMedia` reject with `NotAllowedError`, as in a browser.

## Errors

When a command fails, it prints `acdev: <reason>` and exits with code 1. If the session has already exited, it says `acdev dev <pid> is gone`. `inspect --find` and `query` that find nothing are not failures; they exit with code 2.
