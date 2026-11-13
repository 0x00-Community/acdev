// What the checks here share. They run under `acde run <check.mjs>` (crates/acde: no Node): the napi exports are
// `globalThis.acde_native`, the process and files `acde_sys`, timers `acde_host`. run.sh starts them with HOME and
// TMPDIR in a fresh scratch directory.
export const native = globalThis.acde_native
export const sys = globalThis.acde_sys
const host = globalThis.acde_host
export const env = sys.env()

/** Messages of errors a check throws on purpose (from a callback): reported, not fatal. */
export const tolerated = new Set()
let exiting = false
// anything else uncaught (a throw, a failed await at the top level) fails the check instead of only being printed;
// once exiting, callbacks still queued only see the terminated isolate
host.setReporter((error) => {
  if (exiting) return
  if (tolerated.has(error?.message)) return print(`(uncaught, expected: ${error.message})`)
  print(`FAIL uncaught: ${error?.stack ?? error}`)
  exit(1)
})

function exit(code) {
  exiting = true
  sys.exit(code)
}

export const sleep = (ms) => new Promise((resolve) => host.setTimer(ms, () => resolve()))
/** ms, monotonic, sub-millisecond */
export const now = () => host.now()
export const join = (...parts) => parts.join('/').replace(/\/+/g, '/')
export const print = (line) => sys.stdout(`${line}\n`)

/** A new directory under TMPDIR (run.sh points it at the scratch directory). */
export function tempDir(prefix) {
  const dir = join(env.TMPDIR || '/tmp', `${prefix}${host.randomUUID().slice(0, 8)}`)
  sys.mkdir(dir)
  return dir
}

/** Run a program, throwing when it fails: its stdout. */
export function run(...argv) {
  const { status, stdout, stderr } = sys.run(argv)
  if (status !== 0) throw new Error(`${argv.join(' ')}: ${status} ${stderr}`)
  return stdout
}

const plain = (value) => (value instanceof Uint8Array ? [...value] : value)
export const show = (value) => JSON.stringify(value, (_, v) => (v === undefined ? '<undefined>' : plain(v)))

/** isDeepStrictEqual for JSON-like values and byte arrays. */
export function same(a, b) {
  a = plain(a)
  b = plain(b)
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return Number.isNaN(a) && Number.isNaN(b)
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
}

export class Checks {
  passed = 0
  failed = 0

  check(label, got, want) {
    if (same(got, want)) return this.passed++
    this.failed++
    print(`FAIL ${label}\n  got:  ${show(got)}\n  want: ${show(want)}`)
  }

  async until(what, cond, ms = 5000) {
    const end = now() + ms
    while (!cond()) {
      if (now() > end) {
        this.failed++
        print(`FAIL timeout: ${what}`)
        return false
      }
      await sleep(10)
    }
    this.passed++
    return true
  }

  /** Print the totals and exit (1 when anything failed). */
  done() {
    print(`${this.passed} passed, ${this.failed} failed`)
    exit(this.failed ? 1 : 0)
  }
}

/** A rejected native call's failure JSON ({status, code, message}), or null when it succeeded. */
export async function failure(promise) {
  try {
    await promise
    return null
  } catch (e) {
    const { status, code, message } = JSON.parse(e.message)
    return { status, code, message }
  }
}

/** The same for a synchronous call. */
export function failureOf(call) {
  try {
    call()
    return null
  } catch (e) {
    const { status, code, message } = JSON.parse(e.message)
    return { status, code, message }
  }
}
