# Debugging

acdert has no browser developer tools. Instead, a set of commands connects to a running `acde dev` and lets you look at pages, run code, take screenshots, and click buttons. Run them in another terminal:

```sh
acde webs
```

```text
NAME             KIND     APP     WINDOW   TITLE
desktop          desktop  -       0        Dopame
notes#1048576    app      notes   1048576  Notes
```

## Sessions

These commands find an `acde dev` in this order: `--session <pid>`; otherwise the session whose project directory contains the current directory; otherwise the only session, if there is just one; otherwise they fail and list all sessions.

## Commands

| Command | What it does |
| --- | --- |
| `acde webs` | Lists the running pages (one per window) |
| `acde eval <web> <code>` | Runs code in a page and prints the result as JSON; Promises are awaited. With `-` as the code, reads it from stdin |
| `acde shot <web> [-o FILE]` | Screenshot of one window (PNG) |
| `acde screen [-o FILE]` | Screenshot of the whole screen, all windows together |
| `acde inspect [--window W] [--find TEXT] [--all] [--offscreen]` | Turns the screen into text: the window list and the element tree of the focused window |
| `acde act <ref> <action> [arg]` | Clicks, types, presses keys, and more on a ref from `inspect` |
| `acde console [--web W] [--level L] [--follow]` | The pages' `console.*` output and uncaught errors |
| `acde network [--web W] [--failed] [--follow]` | The pages' fetch / XHR / WebSocket / EventSource requests |

`<web>` is a web name (`notes#1048576`), an app id (that app's first window), or `desktop`.

### eval

```sh
acde eval notes 'document.title'
acde eval notes 'import("acde:fs").then(m => m.fs.roots())'
echo 'localStorage.length' | acde eval notes -
```

### inspect and act

```sh
$ acde inspect
- window "Notes" [focused] [w1]
  - textbox "Title" [w1.12]
  - button "Save" [w1.15]
  - list [w1.20]
    - listitem "Buy milk" [w1.21]

$ acde act w1.12 type "Weekly report"
$ acde act w1.15 click
```

Actions: `click` `double` `right` `hover` `scroll` `type` `settext` `select` `key` `drag` `focus`; a window ref (`w1`) also accepts `close` `minimize` `restore`. The argument to `key` looks like `"ctrl+a backspace"`; the argument to `drag` is the target ref. After each action, `act` waits for the page to settle and then prints what changed.

### console and network

```sh
acde console --level errors --follow
acde network --failed
```

`--level` is `log`, `info`, `warn`, `error`, `debug`, or `errors` (`console.error` plus uncaught errors). `--follow` keeps printing new entries.

The most recent 5000 entries of each kind are kept.

## Errors

When a command fails, it prints `acde: <reason>` and exits with code 1. If the `acde dev` has already exited, it says `acde dev <pid> is gone`.
