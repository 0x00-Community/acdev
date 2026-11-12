import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Acde } from 'acde/driver'
import { perform, type DriverRequest } from './drive'
import type { Test } from './prepare'

const STATE = process.env.WPT_STATE ?? join(import.meta.dir, '..', '..', 'logs', 'wpt')
const { values } = parseArgs({
  options: {
    label: { type: 'string', default: new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-') },
    workers: { type: 'string', default: '3' },
    first: { type: 'string', default: '1' },
    dirs: { type: 'string', default: '' },
    limit: { type: 'string', default: '0' },
    acdert: { type: 'string', default: process.env.ACDERT ?? '' },
    'timeout-scale': { type: 'string', default: '1' },
    retry: { type: 'boolean', default: false },
    flag: { type: 'string', default: '' },
    rerun: { type: 'boolean', default: false },
  },
})
if (!values.acdert) throw new Error('--acdert <path to acdert> (or ACDERT) is required')
const WORKERS = Number(values.workers)
const FIRST = Number(values.first)
const SCALE = Number(values['timeout-scale'])
const OUT = join(STATE, 'results', values.label!)
const DATA = join(STATE, 'work', 'data', values.label!)
mkdirSync(OUT, { recursive: true })
const RESULTS = join(OUT, 'results.jsonl')
const ACTIVE = join(STATE, 'run.active')

type Sub = { name: string; status: number; message: string | null }
type Result = { url: string; status: string; message?: string | null; tests?: Sub[]; ms: number; worker: number; attempt?: number }

const HARNESS = ['OK', 'ERROR', 'TIMEOUT', 'PRECONDITION_FAILED']
const only = values.dirs ? values.dirs.split(',').map((d) => '/' + d.replace(/^\/+|\/+$/g, '') + '/') : null
let list = (JSON.parse(readFileSync(join(STATE, 'tests.json'), 'utf8')) as Test[]).filter((t) => !t.skip && (!only || only.some((d) => t.url.startsWith(d))) && (!values.flag || t.flags.includes(values.flag)))

for (let n = FIRST; n < FIRST + WORKERS; n++)
  if (!existsSync(join(STATE, 'work', `app${n}`, 'acde.config.jsonc'))) throw new Error(`${join(STATE, 'work', `app${n}`)} is missing: run scripts/wpt/wpt.sh prepare --first ${FIRST} --workers ${WORKERS}`)

const done = new Map<string, Result>()
if (existsSync(RESULTS))
  for (const line of readFileSync(RESULTS, 'utf8').split('\n'))
    if (line) {
      const r = JSON.parse(line) as Result
      done.set(r.url, r)
    }
list = list.filter((t) => {
  const r = done.get(t.url)
  return !r || values.rerun || (values.retry && (r.status === 'CRASH' || r.status === 'HANG'))
})
if (Number(values.limit) > 0) list = list.slice(0, Number(values.limit))

const chunks = new Map<string, Test[]>()
for (const t of list) {
  const key = t.url.split('?')[0]!.split('/').slice(1, -1).slice(0, 2).join('/')
  if (!chunks.has(key)) chunks.set(key, [])
  chunks.get(key)!.push(t)
}
const queue = [...chunks.entries()].sort((a, b) => b[1].length - a[1].length)
const total = list.length
let finished = 0
const started = Date.now()
const previous = existsSync(join(OUT, 'meta.json')) ? JSON.parse(readFileSync(join(OUT, 'meta.json'), 'utf8')) : null
const meta = { ...(previous ?? {}), passes: [...(previous?.passes ?? []), { started: new Date().toISOString(), flag: values.flag || null, rerun: values.rerun, dirs: values.dirs || null }], label: values.label, wpt: readFileSync(join(STATE, 'work', 'wpt-sha'), 'utf8').trim(), acdert: values.acdert, started: new Date().toISOString(), workers: WORKERS, dirs: values.dirs || null, platform: process.platform }
writeFileSync(join(OUT, 'meta.json'), JSON.stringify(meta, null, 2) + '\n')
const ownsActive = !existsSync(ACTIVE)
if (ownsActive) writeFileSync(ACTIVE, `${process.pid} ${values.label}\n`)
const releaseActive = () => {
  if (ownsActive) rmSync(ACTIVE, { force: true })
}
console.log(`${total} tests in ${queue.length} chunks, ${done.size} already done, ${WORKERS} workers -> ${OUT}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const gone = (e: unknown) => /closed the connection|no longer connected|not connected|ECONNREFUSED|EPIPE|no web|no page|exited/i.test(String((e as Error)?.message ?? e))

class Worker {
  acde: Acde | null = null
  web = ''
  launches = 0
  constructor(readonly n: number) {}

  async launch(chunk: string) {
    await this.close()
    const data = join(DATA, `w${this.n}`, `${this.launches++}`)
    mkdirSync(data, { recursive: true })
    this.acde = await Acde.launch({
      dirs: [join(STATE, 'work', `app${this.n}`)],
      headless: true,
      force: true,
      timeout: 20000,
      env: { ACDERT: values.acdert!, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(data, 'config'), XDG_CACHE_HOME: join(data, 'cache') },
    })
    const webs = await this.acde.webs()
    const web = webs.find((w) => w.app === `wpt${this.n}`)
    if (!web) throw new Error(`worker ${this.n}: no page after launch for ${chunk}`)
    this.web = web.name
  }

  async close() {
    const acde = this.acde
    this.acde = null
    if (!acde) return
    await Promise.race([acde.close().catch(() => 0), sleep(15000)])
  }

  async eval<T>(code: string): Promise<T> {
    return (await this.acde!.evaluate<T>(this.web, code)) as T
  }

  async runOne(t: Test): Promise<Result> {
    const t0 = Date.now()
    const budget = (t.long ? 60000 : 10000) * SCALE
    const res = (status: string, extra: Partial<Result> = {}): Result => ({ url: t.url, status, ms: Date.now() - t0, worker: this.n, ...extra })
    try {
      await this.eval(`window.__wpt = undefined; window.__old = 1; if (location.pathname + location.search === ${JSON.stringify(t.url)}) location.reload(); else location.href = ${JSON.stringify(t.url)}; 1`)
    } catch (e) {
      return res(gone(e) ? 'CRASH' : 'HANG', { message: `navigate: ${String((e as Error)?.message ?? e).slice(0, 500)}` })
    }
    let loaded = false
    let timedOut = false
    while (true) {
      await sleep(loaded ? 40 : 25)
      let got: unknown
      try {
        got = await this.eval(`window.__old === 1 ? 0 : typeof window.__wpt === 'string' ? window.__wpt : window.__wptdrv && window.__wptdrv.queue.length ? { drive: window.__wptdrv.queue.splice(0) } : 1`)
      } catch (e) {
        if (gone(e)) return res('CRASH', { message: String((e as Error)?.message ?? e).slice(0, 500) })
        if (Date.now() - t0 > budget + 8000) return res('HANG', { message: String((e as Error)?.message ?? e).slice(0, 500) })
        continue
      }
      if (got === 1) loaded = true
      if (got && typeof got === 'object' && 'drive' in got) {
        loaded = true
        for (const req of (got as { drive: DriverRequest[] }).drive) {
          const error = await perform(this.acde!, this.web, req)
          try {
            await this.eval(`window.__wptdrv && window.__wptdrv.done(${req.id}, ${JSON.stringify(error)}); 1`)
          } catch (e) {
            if (gone(e)) return res('CRASH', { message: String((e as Error)?.message ?? e).slice(0, 500) })
          }
        }
        continue
      }
      if (typeof got === 'string') {
        const r = JSON.parse(got) as { status: number; message: string | null; stack: string | null; tests: Sub[] }
        return res(timedOut ? 'TIMEOUT' : (HARNESS[r.status] ?? `STATUS${r.status}`), { message: r.message, tests: r.tests })
      }
      if (!timedOut && Date.now() - t0 > budget) {
        timedOut = true
        try {
          await this.eval(`typeof timeout === 'function' ? (timeout(), 1) : 0`)
        } catch (e) {
          if (gone(e)) return res('CRASH', { message: String((e as Error)?.message ?? e).slice(0, 500) })
          return res('HANG', { message: `timeout(): ${String((e as Error)?.message ?? e).slice(0, 500)}` })
        }
      }
      if (timedOut && Date.now() - t0 > budget + 3000) return res('TIMEOUT', { message: loaded ? 'no completion after timeout()' : 'page never loaded' })
    }
  }

  async work() {
    let failures = 0
    while (queue.length) {
      const [key, tests] = queue.shift()!
      try {
        await this.launch(key)
        failures = 0
      } catch (e) {
        const message = String((e as Error)?.message ?? e)
        console.error(`worker ${this.n}: launch failed for ${key}: ${message.split('\n').slice(0, 12).join('\n')}`)
        queue.push([key, tests])
        if (++failures >= 3) {
          console.error(`worker ${this.n}: stops after ${failures} launch failures in a row`)
          return
        }
        continue
      }
      for (const t of tests) {
        let r = await this.runOne(t)
        if (r.status === 'CRASH' || r.status === 'HANG') {
          try {
            await this.launch(key)
            const again = await this.runOne(t)
            r = { ...again, attempt: 2, message: again.status === r.status ? `${r.message} | retry: ${again.message}` : again.message }
            if (again.status === 'CRASH' || again.status === 'HANG') await this.launch(key)
          } catch (e) {
            console.error(`worker ${this.n}: relaunch failed in ${key}: ${String((e as Error)?.message ?? e).split('\n')[0]}`)
          }
        }
        record(r)
      }
      await this.close()
      rmSync(join(DATA, `w${this.n}`), { recursive: true, force: true })
    }
  }
}

function record(r: Result) {
  appendFileSync(RESULTS, JSON.stringify(r) + '\n')
  finished++
  if (finished % 100 === 0 || finished === total) {
    const rate = finished / ((Date.now() - started) / 1000)
    console.log(`${finished}/${total} (${rate.toFixed(1)}/s, eta ${Math.round((total - finished) / rate / 60)} min)`)
  }
}

const workers = Array.from({ length: WORKERS }, (_, i) => new Worker(FIRST + i))
const stop = async () => {
  await Promise.all(workers.map((w) => w.close()))
  releaseActive()
  process.exit(130)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
try {
  await Promise.all(workers.map((w) => w.work()))
} finally {
  releaseActive()
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({ ...meta, finished: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000) }, null, 2) + '\n')
}
console.log(`done in ${Math.round((Date.now() - started) / 1000)} s`)
