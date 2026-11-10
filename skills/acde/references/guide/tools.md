# Debugging

acdert has no browser developer tools. Instead, a set of commands connects to a running `acde dev` session and lets you look at pages, run code, take screenshots, and click buttons. Run them in another terminal:

```sh
acde webs
```

```text
NAME             KIND     APP     WINDOW   TITLE
desktop          desktop  -       0        Dopame
notes#1048576    app      notes   1048576  Notes
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
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | Turns the screen into text: the window list and the element tree of the focused window (`--all`: every window, and elements hidden by `opacity: 0` or `visibility`) |
| `acde act <ref> <action> [arg]` | Clicks, types, presses keys, and more on a ref from `inspect` |
| `acde console [--web W] [--level L] [--follow]` | The pages' `console.*` output and uncaught errors |
| `acde network [--web W] [--failed] [--follow]` | The pages' fetch / XHR / WebSocket / EventSource requests and their image, stylesheet and font loads; the kind column says which |

A **web** is one page: the desktop page, or the page in one app window (each window has one). `<web>` is a web name from `acde webs` (`notes#1048576`), an app id (that app's first window), or `desktop`.

### eval

```sh
acde eval notes 'document.title'
acde eval notes 'import("acde:fs").then(m => m.fs.roots())'
echo 'localStorage.length' | acde eval notes -
```

### inspect and act

`inspect` gives every element a **ref**, such as `w1.12` (element 12 in window `w1`); pass it to `act`.

```sh
$ acde inspect
- window "Notes" [app=notes] [focused] [w1]
  - textbox "Title" [w1.12]
  - button "Save" [w1.15]
  - list [w1.20]
    - listitem "Buy milk" [w1.21]

$ acde act w1.12 type "Weekly report"
$ acde act w1.15 click
```

The text is always in this English format: one line per window, top first (`- window "Notes" [app=notes] [focused] [w1]`, the desktop is `- desktop`), and under a listed window its elements, indented two spaces per level, as `- role "name" [states] [ref]`. Notes in parentheses say what is left out or unchanged, such as `(empty)`, `(no changes)` and `(windows unchanged)`.

A ref stays the same as long as its element lives: moving it, changing its text or attributes, or reordering a list keeps it. When the page replaces the element with a new one (for example by setting `innerHTML`), the new element gets a new ref, and acting on the old one fails with `element N is gone`; take a new `inspect` then.

By default the tree leaves out elements that can't be seen: `display: none`, `aria-hidden`, `inert`, `opacity: 0` and hidden `visibility`. `--all` lists every window that isn't minimized and also keeps the elements hidden by `opacity: 0` (marked `transparent`; they can still be clicked) or by `visibility` (marked `invisible`; they can't); `display: none`, `aria-hidden` and `inert` are always left out.

`--find TEXT` looks in every visible window (or `--window W`) and prints only the elements whose name or value contains the text (case does not matter), one per line under their window, each followed by the nearest ancestor that has a name:

```sh
$ acde inspect --find milk
w1 notes "Notes":
- listitem "Buy milk" [w1.21]
```

When nothing matches it says so on stderr and exits with code 1. Elements scrolled out of view are found only with `--offscreen`.

Actions: `click` `double` `right` `hover` `scroll` `type` `settext` `select` `key` `drag` `focus`; a window ref (`w1`) also accepts `close` `minimize` `restore`. The argument to `key` looks like `"ctrl+a backspace"`; the argument to `drag` is the target ref. After each action, `act` waits for the page to settle and then prints what changed. When closing a window ends acdert (the app's window when `acde dev` runs one app), `acde dev` ends with it; `act w1 close` then says so and exits with code 0.

### console and network

```sh
acde console --level errors --follow
acde network --failed
```

`--level` is `log`, `info`, `warn`, `error`, `debug`, or `errors` (`console.error` plus uncaught errors). `--follow` keeps printing new entries.

Entries stay after a page reloads, so errors from before a change are still listed. The first column is the entry's number. `--since reload` lists only what came after `acde dev` last rebuilt and reloaded (everything, if it has not reloaded yet); `--since N` lists entry `N` and later. A reload the page does by itself (`location.reload()`) does not count.

```sh
acde console --level errors --since reload
```

The most recent 5000 entries of each kind are kept.

## Errors

When a command fails, it prints `acde: <reason>` and exits with code 1. If the session has already exited, it says `acde dev <pid> is gone`.
