// Terminals on real ptys: the behaviour of app-terminal pty.ts (sessions, input, resize, close, backlog before
// subscribe, cwd events, exit, attach timeout, SIGKILL after hang-up, limits) and batching.
// Usage: run.sh <acde> terminal-check.mjs (run.sh sets HOME and SHELL=/bin/bash)
import { Checks, env, failureOf as err, native, print, sleep, tolerated } from './check.mjs'

const home = env.HOME
const { Terminals } = native
const t0 = new Checks()
const check = (...args) => t0.check(...args)
const until = (...args) => t0.until(...args)

/** Subscribe and collect: text so far, events, batches. */
function follow(t, id) {
  const seen = { text: '', events: [], batches: 0, sizes: [] }
  t.subscribe(id, (events) => {
    seen.batches++
    seen.sizes.push(events.reduce((n, e) => n + (e.data?.length ?? 0), 0))
    for (const e of events) { seen.events.push(e); if (e.type === 'output') seen.text += e.data }
  })
  return seen
}

const t = new Terminals()
check('cols too small', err(() => t.open(1, 24)), { status: 400, code: 'invalid_request', message: 'cols must be an integer in [2, 1000]' })
check('rows not integer', err(() => t.open(80, 24.5)), { status: 400, code: 'invalid_request', message: 'rows must be an integer in [2, 1000]' })
check('rows too big', err(() => t.open(80, 1001)), { status: 400, code: 'invalid_request', message: 'rows must be an integer in [2, 1000]' })
check('unknown input', err(() => t.input('nope', 'x')), { status: 404, code: 'http_error', message: 'no such terminal' })
check('unknown resize', err(() => t.resize('nope', 80, 24)), { status: 404, code: 'http_error', message: 'no such terminal' })
check('unknown subscribe', err(() => t.subscribe('nope', () => {})), { status: 404, code: 'http_error', message: 'no such terminal' })
check('close unknown', t.close('nope'), { closed: 'nope' })

// a session: output, cwd, resize, UTF-8 split across reads, exit
{
  const { id } = t.open(80, 24)
  check('id is a uuid', /^[0-9a-f-]{36}$/.test(id), true)
  const s = follow(t, id)
  check('input', t.input(id, 'echo he""llo; pwd\n'), { ok: true })
  await until('echo output', () => s.text.includes('hello') && s.text.includes(home))
  await until('cwd ~', () => s.events.some((e) => e.type === 'cwd' && e.path === '~'))
  t.input(id, 'cd /tmp\n')
  await until('cwd /tmp', () => s.events.some((e) => e.type === 'cwd' && e.path === '/tmp'), 3000)
  check('resize', t.resize(id, 100, 30), { cols: 100, rows: 30 })
  check('resize invalid', err(() => t.resize(id, 100, 1)), { status: 400, code: 'invalid_request', message: 'rows must be an integer in [2, 1000]' })
  t.input(id, 'stty size\n')
  await until('stty size', () => s.text.includes('30 100'))
  t.input(id, "printf '\\xe4\\xb8'; sleep 0.3; printf '\\xad|\\n'\n")
  await until('split UTF-8 joined', () => s.text.includes('中|'))
  check('no replacement character', s.text.includes('�'), false)
  check('input too long', err(() => t.input(id, 'x'.repeat(65537))), { status: 400, code: 'invalid_request', message: 'data must be a string of at most 65536 characters' })
  // batching: 200k lines arrive in far fewer callbacks than reads of a line each
  const before = s.batches
  t.input(id, 'seq 1 200000; echo SEQ-$((1+1))-DONE\n')
  await until('seq output', () => s.text.includes('200000\r\nSEQ-2-DONE\r\n'), 20000)
  const batches = s.batches - before, bytes = s.sizes.slice(before).reduce((a, b) => a + b, 0)
  print(`seq: ${bytes} chars in ${batches} callbacks (largest ${Math.max(...s.sizes.slice(before))})`)
  check('output is batched (≥ 4 KiB per callback on average)', bytes / batches > 4096, true)
  t.input(id, 'exit 7\n')
  await until('exit 7', () => s.events.some((e) => e.type === 'exit'))
  check('exit event last', s.events.at(-1), { type: 'exit', code: 7, signal: null })
  await sleep(50)
  check('closed after exit', err(() => t.input(id, 'x')), { status: 404, code: 'http_error', message: 'no such terminal' })
}

// before anyone subscribes: output and exit wait in the backlog; a late subscriber gets them, then it closes
{
  const { id } = t.open(80, 24)
  t.input(id, 'echo early-$((6*7)); exit 3\n')
  await sleep(1500)
  const s = follow(t, id)
  await until('backlog delivered', () => s.events.some((e) => e.type === 'exit'), 2000)
  check('backlog has the output', s.text.includes('early-42'), true)
  check('backlog ends with exit', s.events.at(-1), { type: 'exit', code: 3, signal: null })
  await sleep(50)
  check('closed after a late subscribe', err(() => t.input(id, 'x')), { status: 404, code: 'http_error', message: 'no such terminal' })
}

// a signal ends it: exit carries the signal
{
  const { id } = t.open(80, 24)
  const s = follow(t, id)
  t.input(id, 'kill -9 $$\n')
  await until('killed', () => s.events.some((e) => e.type === 'exit'))
  check('exit by SIGKILL', s.events.at(-1), { type: 'exit', code: null, signal: 9 })
}

// closing hangs up: a program that ignores SIGHUP is killed 3 s later; the listener still sees the exit
{
  const { id } = t.open(80, 24)
  const s = follow(t, id)
  t.input(id, "trap '' HUP; echo TRAPPED; while :; do sleep 1; done\n")
  await until('trap set', () => s.text.includes('TRAPPED\r\n'))
  const at = Date.now()
  check('close', t.close(id), { closed: id })
  check('close twice', t.close(id), { closed: id })
  check('gone at once', err(() => t.resize(id, 80, 24)), { status: 404, code: 'http_error', message: 'no such terminal' })
  await until('killed after hang-up', () => s.events.some((e) => e.type === 'exit'), 6000)
  const took = Date.now() - at
  check('SIGKILL after about 3 s', took > 2500 && took < 5000, true)
  check('exit by SIGKILL', s.events.at(-1), { type: 'exit', code: null, signal: 9 })
}

// a callback that throws does not take the process down; the terminal keeps working
{
  const { id } = t.open(80, 24)
  let calls = 0
  tolerated.add('page bug')
  t.subscribe(id, () => { calls++; throw new Error('page bug') })
  t.input(id, 'echo a; sleep 0.2; echo b; exit\n')
  await until('throwing callback still called', () => calls >= 2)
  await sleep(500)
  check('closed after exit despite throws', err(() => t.input(id, 'x')), { status: 404, code: 'http_error', message: 'no such terminal' })
}

// at most 8 at once
{
  const ids = Array.from({ length: 8 }, () => t.open(80, 24).id)
  check('ninth refused', err(() => t.open(80, 24)), { status: 429, code: 'http_error', message: 'at most 8 terminals' })
  for (const id of ids) t.close(id)
  check('room again', typeof t.open(80, 24).id, 'string')
  t.closeAll()
}

// never subscribed: gone after 15 s
{
  const { id } = t.open(80, 24)
  await sleep(14_000)
  check('still there at 14 s', t.input(id, 'true\n'), { ok: true })
  await sleep(2_000)
  check('gone after 15 s', err(() => t.input(id, 'x')), { status: 404, code: 'http_error', message: 'no such terminal' })
}

t0.done()
