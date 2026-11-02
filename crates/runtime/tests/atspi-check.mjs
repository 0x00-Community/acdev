// runtime's Accessibility (AT-SPI) on the test windows atspi-check.sh starts: the tree of a window by pid (roles,
// names, values, states, actions), clicking a button, typing into and replacing a text field, focusing, and the
// errors. A toolkit whose pid is empty (not installed) is skipped.
// Usage: atspi-check.sh <acde>
import { Checks, env, failure, native, now, print, sleep } from './check.mjs'

const t = new Checks()
const a11y = await native.Accessibility.open()

const nodes = (node) => [node, ...(node?.children ?? []).flatMap(nodes)]
const find = (tree, role, test = () => true) => nodes(tree).find((n) => n.role === role && test(n))
const count = (tree) => nodes(tree).length

async function treeOf(pid, title, ready) {
  const end = now() + 15000
  while (now() < end) {
    const text = await a11y.tree(pid, title, 400)
    const tree = text && JSON.parse(text)
    if (tree && ready(tree)) return tree
    await sleep(100)
  }
  return null
}

async function timed(pid, title) {
  const started = now()
  const tree = JSON.parse(await a11y.tree(pid, title, 400))
  return { tree, ms: now() - started }
}

const short = (node) => JSON.stringify({ ...node, children: node.children.length })

async function toolkit(label, pid, title, text) {
  if (!pid) return print(`${label}: not installed, skipped`)
  const pressedLabel = (n) => /^pressed \d+$/.test(n.name)
  const tree = await treeOf(Number(pid), title, (tr) => find(tr, 'button', (n) => n.name === 'Press me') && find(tr, 'textbox'))
  t.check(`${label}: the window's tree has the button and the text field`, !!tree, true)
  if (!tree) return
  const { tree: again, ms } = await timed(Number(pid), title)
  print(`${label}: ${count(again)} nodes in ${ms.toFixed(1)} ms`)
  t.check(`${label}: the root is the window`, [tree.role, tree.name], ['window', title])
  const button = find(tree, 'button', (n) => n.name === 'Press me')
  const field = find(tree, 'textbox')
  const box = find(tree, 'checkbox')
  print(`${label}: ${short(tree)}`)
  for (const node of [button, field, box, find(tree, text, pressedLabel)]) if (node) print(`${label}:   ${short(node)}`)
  t.check(`${label}: node ids are <bus>|<path>`, /^:\d+\.\d+\|\//.test(button.id), true)
  t.check(`${label}: the check box`, box?.name, 'Remember')
  t.check(`${label}: the button has a rect`, Array.isArray(button.rect) && button.rect[2] > 0 && button.rect[3] > 0, true)
  t.check(`${label}: the button has actions`, button.actions.length > 0, true)
  t.check(`${label}: the label`, find(tree, text, pressedLabel)?.name, 'pressed 0')

  t.check(`${label}: click`, await a11y.act(button.id, 'click'), true)
  t.check(`${label}: the click reached the app`, !!(await treeOf(Number(pid), title, (tr) => find(tr, text, (n) => n.name === 'pressed 1'))), true)

  t.check(`${label}: focus the field`, await a11y.act(field.id, 'focus'), true)
  t.check(`${label}: type`, await a11y.act(field.id, 'type', 'hello 你好'), true)
  const typed = await treeOf(Number(pid), title, (tr) => find(tr, 'textbox')?.value === 'hello 你好')
  t.check(`${label}: the field's value`, find(typed, 'textbox')?.value, 'hello 你好')
  t.check(`${label}: the field is focused and editable`, ['focused', 'editable'].every((s) => find(typed, 'textbox')?.states.includes(s)), true)
  t.check(`${label}: settext`, await a11y.act(field.id, 'settext', 'replaced'), true)
  t.check(`${label}: the field's new value`, !!(await treeOf(Number(pid), title, (tr) => find(tr, 'textbox')?.value === 'replaced')), true)
  t.check(`${label}: typing into a button does nothing`, await a11y.act(button.id, 'type', 'x'), false)

  const small = JSON.parse(await a11y.tree(Number(pid), title, 2))
  t.check(`${label}: limit 2 gives 2 nodes`, count(small), 2)
  t.check(`${label}: what was cut is counted`, nodes(small).some((n) => n.more > 0), true)
}

await toolkit('GTK 3', env.ATSPI_GTK_PID, 'acde gtk check', 'text')
await toolkit('Qt Quick', env.ATSPI_QT_PID, 'acde qt check', 'text')

t.check('no such pid: null', await a11y.tree(1, null, 10), null)
t.check('unknown action', (await failure(a11y.act(':1.1|/x', 'drag')))?.code, 'invalid_request')
t.check('bad node id', (await failure(a11y.act('nonsense', 'click')))?.code, 'invalid_request')
t.check('a gone node: false', await a11y.act(':1.99999|/org/a11y/atspi/accessible/1', 'click'), false)
t.done()
