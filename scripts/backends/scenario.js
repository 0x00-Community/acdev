window.runScenario = async function runScenario(full) {
  const out = {}
  const step = async (name, run) => {
    try {
      out[name] = { ok: true, ...(await run()) }
    } catch (error) {
      out[name] = { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }
  const socket = () => new Promise((resolve, reject) => {
    const ws = new WebSocket('/ws')
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => resolve(ws)
    ws.onerror = () => reject(new Error('websocket error'))
  })
  const next = (ws) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('websocket message timed out')), 8000)
    ws.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event.data)
    }
  })
  const check = (ok, what) => {
    if (!ok) throw new Error(what)
  }

  await step('get', async () => {
    const response = await fetch('/api/hello')
    const body = await response.text()
    check(response.status === 200 && body.startsWith('hello'), `GET ${response.status} ${body}`)
    return {}
  })
  await step('post', async () => {
    const body = 'payload-' + 'x'.repeat(5000)
    const text = await (await fetch('/api/echo', { method: 'POST', headers: { 'content-type': 'text/plain' }, body })).text()
    check(text === 'echo:POST:' + body, `echo of ${text.length} characters`)
    return {}
  })
  await step('chunked', async () => {
    const reader = (await fetch('/api/chunked?n=5&ms=100')).body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let pieces = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pieces++
      text += decoder.decode(value, { stream: true })
    }
    check(text === 'chunk0;chunk1;chunk2;chunk3;chunk4;' && pieces >= 2, `${pieces} pieces: ${text}`)
    return { pieces }
  })
  await step('concurrent', async () => {
    const t0 = performance.now()
    const got = await Promise.all(Array.from({ length: 8 }, (_, i) => fetch(`/api/slow?ms=400&i=${i}`).then((r) => r.text())))
    const ms = Math.round(performance.now() - t0)
    check(got.every((text, i) => text === `slow:${i}`) && ms < 3200, `${ms} ms: ${got}`)
    return { ms }
  })
  await step('download', async () => {
    const n = 2 * 1024 * 1024
    const bytes = new Uint8Array(await (await fetch('/api/big?n=' + n)).arrayBuffer())
    let same = bytes.length === n
    for (let i = 0; same && i < n; i += 4099) same = bytes[i] === ((i * 31) & 0xff)
    check(same, `${bytes.length} bytes`)
    return {}
  })
  await step('upload', async () => {
    const n = 2 * 1024 * 1024
    const data = new Uint8Array(n)
    let sum = 0
    for (let i = 0; i < n; i++) {
      data[i] = (i * 7) & 0xff
      sum += data[i]
    }
    const text = await (await fetch('/api/sum', { method: 'POST', body: data })).text()
    check(text === n + ':' + (sum % 1000000007), text)
    return {}
  })
  await step('websocket', async () => {
    const ws = await socket()
    ws.send('ping')
    const text = await next(ws)
    ws.send(new Uint8Array([1, 2, 3, 250]))
    const binary = Array.from(new Uint8Array(await next(ws)))
    check(text === 'echo:ping' && binary.join() === '1,2,3,250', `${text} ${binary}`)
    let big = 0
    if (full) {
      ws.send('big:' + 'b'.repeat(1024 * 1024))
      big = (await next(ws)).length
      check(big === 4 + 1024 * 1024, `${big}`)
    }
    const closed = new Promise((resolve) => (ws.onclose = (event) => resolve(event.code)))
    ws.close(1000, 'done')
    check((await closed) === 1000, 'close code')
    return {}
  })
  if (full) {
    await step('pubsub', async () => {
      const a = await socket()
      const b = await socket()
      a.send('join')
      b.send('join')
      await Promise.all([next(a), next(b)])
      const both = Promise.all([next(a), next(b)])
      a.send('publish:room')
      const got = await both
      a.close()
      b.close()
      check(got.join() === 'room:room,room:room', String(got))
      return {}
    })
  }
  return out
}
