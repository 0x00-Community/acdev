const PREFIX = 'acde:'
const STUB = '\0acde-stub:'

const stub = (name) => `const fail = (path) => Promise.reject(new Error(\`\${path}: only there when the app runs in acde\`))
const make = (path) => new Proxy(function () {}, {
  get: (_, key) => (key === 'then' || typeof key === 'symbol' ? undefined : key === 'on' ? () => () => false : make(\`\${path}.\${key}\`)),
  apply: () => fail(path),
})
const value = make(${JSON.stringify(PREFIX + name)})
export { value as ${JSON.stringify(name)} }
export default value
`

export default function acde() {
  let serve = false
  return {
    name: 'acde',
    enforce: 'pre',
    configResolved(config) {
      serve = config.command === 'serve'
    },
    resolveId(id) {
      if (!id.startsWith(PREFIX)) return null
      return serve ? STUB + id.slice(PREFIX.length) : { id, external: true }
    },
    load(id) {
      return id.startsWith(STUB) ? stub(id.slice(STUB.length)) : null
    },
  }
}
