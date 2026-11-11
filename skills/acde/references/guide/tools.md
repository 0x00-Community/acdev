# Debugging

acdert has no browser developer tools. Instead, a set of commands connects to a running `acde dev` session and lets you look at pages, run code, take screenshots, and click buttons. Run them in another terminal:

```sh
acde webs
```

```text
NAME           KIND     APP    WINDOW   TITLE
desktop        desktop  -      0        My Desktop
notes#1048576  app      notes  1048576  Notes
```

## Sessions

These commands find an `acde dev` session in this order: `--session <pid>`; otherwise the session whose project directory contains the current directory; otherwise the only session, if there is just one; otherwise they fail and list all sessions.

## Commands

| Command | What it does |
| --- | --- |
| `acde webs` | Lists the running pages (one per window) |
| `acde eval <web> <code>` | Runs code in a page and prints the result as JSON; Promises are awaited. With `-` as the code, reads it from stdin |
| `acde shot <web> [-o FILE]` | Screenshot of one window (PNG) |
| `acde screen [-o FILE]` | Screenshot of the whole screen, all windows together |
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | Turns the screen into text: the window list and the element tree of the focused window (`--all`: every window that is not marked `[minimized]`, and elements hidden by `opacity: 0` or `visibility`) |
| `acde query <selector> [--window W] [--ref REF] [--limit N]` | Finds elements by CSS selector, including ones `inspect` leaves out, and prints a ref for each |
| `acde act <ref> <action> [arg]` | Clicks, types, presses keys, and more on a ref from `inspect` or `query` |
| `acde console [--web W] [--level L] [--since S] [--follow]` | The pages' `console.*` output and uncaught errors |
| `acde network [--web W] [--failed] [--since S] [--follow]` | The pages' fetch / XHR / WebSocket / EventSource requests and their image, stylesheet and font loads; the kind column says which |
| `acde permissions` | Lists the approval prompts that wait and the decisions made; see [Approvals](#approvals) |
| `acde allow` / `acde deny` `[<prompt id> \| <app> <capability>] [--all]` | Answers a waiting approval prompt |
| `acde revoke <app> <capability>` | Takes back a decision |
| `acde stop` | Ends the session; see [Stopping](dev.md#stopping) |

A **web** is one page: the desktop page, or the page in one app window (each window has one). `<web>` is a web name from `acde webs` (`notes#1048576`), an app id (that app's first window), or `desktop`.

### eval

```sh
acde eval notes 'document.title'
acde eval notes 'import("acde:fs").then(m => m.fs.roots())'
echo 'localStorage.length' | acde eval notes -
```

On Windows, `acde` is `acde.exe`, which hands its arguments to the CLI exactly as the shell passed them. What a shell passes differs:

- PowerShell 7: double quotes inside a single-quoted argument arrive unchanged (`acde eval notes 'document.querySelector("#x").textContent'`).
- Windows PowerShell 5.1 drops double quotes inside arguments to every program; there, write them as `\"` (the first line below).
- cmd has no single-quoted strings: put the argument in double quotes and write the double quotes inside it as `\"` (the second line below).

```powershell
acde eval notes 'document.querySelector(\"#x\").textContent'   # Windows PowerShell 5.1 only
```

```bat
acde eval notes "document.querySelector(\"#x\").textContent"
```

Code that has only single quotes inside it is written the same way in all three, and passing the code on stdin avoids the question (shown for PowerShell):

```powershell
acde eval notes "document.querySelector('#x').textContent"
'document.querySelector("#x").textContent' | acde eval notes -
```

The same applies to any argument with double quotes, such as `act ... type`. `bin\acde.cmd` is still installed next to `acde.exe` as a fallback (`acde.cmd …`), but PowerShell drops double quotes in the arguments it passes to a `.cmd`.

### inspect and act

`inspect` gives every element a **ref**, such as `w1.18` (element 18 in window `w1`); pass it to `act`.

```sh
$ acde inspect
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

$ acde act w1.18 type "Weekly report"
typed, the value is now "Weekly report"

(windows unchanged)
- window "Notes" [app=notes] [focused] [fullscreen] [w1]
  ~ - textbox "Title": "Weekly report" [focused] [w1.18]
  (1 more outside the visible area; scroll, or add offscreen)

$ acde act w1.21 click
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

`act` exits with code 0 when the action was done. When it was not, the reason is the only line and the exit code is 1: `the element is not displayed` (it is `display: none` or hidden by `visibility`), `covered by another element: <div> (27)`, `cannot type into this element`, `element 23 is gone` (see below), `w1 is minimized; act restore on it first` (a click or another pointer action on a minimized window or on an element in it).

A ref stays the same as long as its element lives: moving it, changing its text or attributes, or reordering a list keeps it. When the page replaces the element with a new one (for example by setting `innerHTML`), the new element gets a new ref, and acting on the old one fails with `element N is gone`; take a new `inspect` then.

By default the tree leaves out elements that can't be seen: `display: none`, `aria-hidden`, `inert`, `opacity: 0` and hidden `visibility`. `--all` lists every window that is not marked `[minimized]` in the window list and also keeps the elements hidden by `opacity: 0` (marked `transparent`; they can still be clicked) or by `visibility` (marked `invisible`; they can't); `display: none`, `aria-hidden` and `inert` are always left out.

A window that is off the screen is marked `[minimized]` in the window list: one whose state is `minimized` (after `act w1 minimize`, the app's own `minimize()`, or the desktop's `windows.requestState(id, 'minimized')`), and one the desktop hid with `windows.hide(id)`. Its elements are not listed: `--all` and `--find` skip it, and `--window w1` prints `(empty)` and `(minimized; act restore on it to see its elements)` under its line. Pointer actions on it (`click`, `double`, `right`, `hover`, `scroll`, and `drag` from or onto it) are refused, and `act w1 restore` brings it back. In a desktop session:

```sh
$ acde act w1 minimize
w1 is minimized (the windows changed)

- window "Tools" [app=tools] [minimized] [w1]
- desktop [focused] [fullscreen] [w0]
  - navigation "Apps" [w0.6]
    - button "Tools" [w0.10]

$ acde act w1.10 click
w1 is minimized; act restore on it first

$ acde act w1 restore
w1 is in front (the windows changed)

- window "Tools" [app=tools] [focused] [w1]
  + - heading "Tools" [level=1] [w1.10]
- desktop [fullscreen] [w0]
```

`--find TEXT` looks in every window that is not marked `[minimized]` (or in `--window W`) and prints only the elements whose name or value contains the text (case does not matter). Its output has a format of its own: a line `<window ref> <app id> "<title>":` for each window that has a match (`w0 desktop:` for the desktop), and under it one line per element. An element inside an ancestor that has a name is followed by `in` and the nearest such ancestor; one that has none is followed by nothing:

```sh
$ acde inspect --find milk
w1 notes "Notes":
- text "Buy milk" [w1.22]  in list "Saved notes" [w1.7]

$ acde inspect --find save
w1 notes "Notes":
- button "Save" [w1.21]
- list "Saved notes" [w1.7]
```

When nothing matches it says so on stderr and exits with code 1. Elements scrolled out of view are found only with `--offscreen`; without it, a note under the tree says how many were left out (`(1 more outside the visible area; scroll, or add offscreen)`).

Actions: `click` `double` `right` `hover` `scroll` `type` `settext` `select` `key` `drag` `focus`; a window ref (`w1`) also accepts `close` `minimize` `restore`. The argument to `key` looks like `"ctrl+a backspace"`; the argument to `drag` is the target ref. When closing a window ends acdert (the app's window when `acde dev` runs one app), `acde dev` ends with it; `act w1 close` then says so and exits with code 0.

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
$ acde query 'form input[type=email]'
1 in w1:
- textbox "Email": "" [w1.20] <input>

$ acde query '[data-testid="menu"] li'
2 in w1:
- generic "Rename" [w1.25] <li> [hidden]
- generic "Delete" [w1.26] <li> [hidden]

$ acde query button
4 in w1:
- button "Save" [focused] [w1.21] <button>
- button "Undo" [transparent] [w1.10] <button> [hidden]
- button [invisible] [w1.24] <button> [hidden]
- button "Load more" [w1.11] <button>

$ acde query nav
nothing in w1 matches "nav"
```

Each line is the element's role, name, value, a heading's level, states and ref, exactly as `inspect` prints them (`- heading "Notes" [level=1] [w1.16] <h1>`), then its tag. `[hidden]` after the tag marks an element that is not visible: it has no size, or is `display: none`, hidden by `visibility`, or transparent, or its window is minimized. The `transparent` and `invisible` marks are the ones `inspect --all` gives: a transparent element still takes clicks, as it does for a user; for an `invisible` or `display: none` one, `act` answers `the element is not displayed` until the page shows it. An element whose role cannot be told is listed as `generic`; the tag says what it is.

The refs work with `act`, like the ones from `inspect`: `acde act w1.20 type "me@example.com"`. `query` searches the focused window; `--window w2` picks another, `--ref w1.6` searches only under that element, and `--limit N` lists at most N elements (1 to 3000, default 600; the first line still counts them all). Finding nothing is not an error: the exit code is 0 either way.

### console and network

```sh
acde console --level errors --follow
acde network --failed
```

`--level` is `log`, `info`, `warn`, `error`, `debug`, or `errors` (`console.error` plus uncaught errors). `--follow` keeps printing new entries.

When a `fetch` in the page rejects with `TypeError: Failed to fetch`, the line of that request in `acde network --failed` says why (a CORS rule, a name that does not resolve, a refused connection):

```sh
$ acde network --failed
   1 GET    ERR https://nonexistent.invalid/  (fetch 158 ms; Failed to connect to host: Failed resolving hostname: failed to lookup address information: nodename nor servname provided, or not known) notes#1048576
```

Entries stay after a page reloads, so errors from before a change are still listed. The first column is the entry's number. `--since reload` lists only what came after `acde dev` last rebuilt and reloaded (everything, if it has not reloaded yet); `--since N` lists entry `N` and later. A reload the page does by itself (`location.reload()`) does not count.

```sh
acde console --level errors --since reload
```

The most recent 5000 entries of each kind are kept.

## Approvals

An app that requires a capability needing the user's approval (`terminal`, `network`, `camera`, `microphone`, `launch`, `slots`, or a shared folder named in `fs.roots`, such as `fs.downloads`) opens no window until the prompt is answered, and nothing answers it by itself (on Windows the host window asks in a dialog; on macOS, on Linux and in a headless session there is no dialog). `acde dev` prints the runtime's line `Notes (notes) waits for the user to allow "fs.downloads" (prompt 1; answer it with acde allow or acde deny, …)`, and `acde webs` lists no page and says what the app waits for. Answer with `acde allow` or `acde deny`:

```sh
$ acde webs
NAME  KIND  APP  WINDOW  TITLE
notes waits for approval of fs.downloads: acde allow (or acde deny)

$ acde permissions
pending:
  1  notes  fs.downloads  (launch)
decisions: none

$ acde allow
allowed notes fs.downloads (prompt 1)

$ acde webs
NAME           KIND  APP    WINDOW   TITLE
notes#1048576  app   notes  1048576  Notes
```

Without arguments, `acde allow` and `acde deny` answer the only waiting prompt. When several wait, they answer none and list them; name one by its id (`acde allow 2`) or by app and capability (`acde allow notes fs.downloads`), or answer them all with `--all`. In a desktop session `acde webs` always lists the desktop's page, so look at `acde permissions` there: an app's prompt is raised when the app is first opened.

Decisions persist per app (in `$XDG_CONFIG_HOME/acde/permissions.json`), so an approval is not asked for again, in this session or later. Approving is the user's decision: when you run these commands for someone, allow only what they asked for or agreed to, and tell them what you allowed.

```sh
$ acde permissions
pending: none
decisions:
  notes  fs.downloads  granted

$ acde revoke notes fs.downloads
revoked notes fs.downloads
```

`acde revoke <app> <capability>` removes a decision. For the rest of this run the capability counts as denied (its calls reject with `code: 'denied'`), and the next run asks again. In a session that runs a single app, an app that has lost a required capability cannot start again: the next reload ends the session, and the next `acde dev` asks.

If you deny a capability the app requires, the app does not start. In a session that runs a single app, `acde dev` then logs `acdert app notes: Notes: "fs.downloads" is denied by the user` and exits with code 1; the next `acde dev` of that app asks again (`Notes (notes) was denied "fs.downloads" in an earlier run: asking again`), so a denial never locks you out of your own app. In a desktop the denial stays until it is revoked: the app leaves the app list and opening it fails with `Notes needs "fs.downloads" (denied by the user)`. Which capabilities need approval, and how an app can make one optional, is in [Capabilities](capabilities.md#approval).

## Errors

When a command fails, it prints `acde: <reason>` and exits with code 1. If the session has already exited, it says `acde dev <pid> is gone`.
