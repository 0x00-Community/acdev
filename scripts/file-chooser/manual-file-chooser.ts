import { mkdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const artifacts = process.argv[2]
if (!artifacts) throw new Error('Run this through scripts/manual-file-chooser.sh')
const run = resolve(artifacts)
const pkg = join(run, 'package')
const home = join(run, 'home')
const state = join(run, 'state')
const sample = join(run, 'sample')
const profileFolders = ['Desktop', 'Documents', 'Downloads', 'Music', 'Pictures', 'Videos']
await Promise.all([pkg, home, state, sample, ...profileFolders.map((name) => join(home, name))]
  .map((path) => mkdir(path, { recursive: true })))
await Bun.write(join(sample, 'notes.txt'), 'plain text sample')
await Bun.write(join(sample, 'picture.png'), 'not really a png, only a name for the filter test')
await Bun.write(join(sample, 'data.csv'), 'a,b\n1,2\n')
await Bun.write(join(pkg, 'package.json'), JSON.stringify({ name: 'manual-file-chooser', acde: {
  apps: [
    { id: 'manual-file-chooser', label: 'Manual File Chooser', icon: 'files',
      entry: '/manual/index.html', capabilities: { fs: { roots: [] }, openFiles: true } },
  ],
  assets: { '/manual/': ['.'] },
} }))
await Bun.write(join(pkg, 'index.html'), `<!doctype html>
<meta charset="utf-8">
<title>Manual File Chooser</title>
<body style="font-family: sans-serif; padding: 16px">
<h2>File chooser check (click each button, then check the result line)</h2>
<p><button id="one">Open one file</button> <button id="many">Open several files</button></p>
<p><label>Accept .png and .jpg only: <input id="png" type="file" accept=".png,.jpg"></label></p>
<p><button id="save">Save a text file</button></p>
<p id="result">Nothing chosen yet.</p>
<script>
const show = (text) => { document.getElementById('result').textContent = text }
const describe = async (handles) => {
  const parts = []
  for (const handle of handles) parts.push(handle.name + ': ' + (await (await handle.getFile()).text()).slice(0, 40))
  return parts.join(' | ')
}
document.getElementById('one').onclick = async () => {
  try { show('Open one: ' + await describe(await showOpenFilePicker())) } catch (e) { show('Open one ended: ' + e.name) }
}
document.getElementById('many').onclick = async () => {
  try { show('Open several: ' + await describe(await showOpenFilePicker({ multiple: true }))) } catch (e) { show('Open several ended: ' + e.name) }
}
document.getElementById('png').onchange = (event) => {
  const names = [...event.target.files].map((file) => file.name)
  show('Input accept: ' + (names.length ? names.join(', ') : 'nothing'))
}
document.getElementById('save').onclick = async () => {
  try {
    const handle = await showSaveFilePicker({ suggestedName: 'saved-from-chooser.txt' })
    const writer = await handle.createWritable()
    await writer.write('written by the manual check')
    await writer.close()
    show('Saved as ' + handle.name)
  } catch (e) { show('Save ended: ' + e.name) }
}
</script>
</body>
`)
const binary = resolve('target', 'release', process.platform === 'win32' ? 'acdert.exe' : 'acdert')
const env = { ...process.env, ACDE_PATH: pkg, ACDE_APP: resolve('web/packages/acde-host/dist'), HOME: home, USERPROFILE: home,
  XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: state }
delete env['ACDE_HEADLESS']
delete env['ACDE_STORAGE']
delete env['ACDE_BACKEND']
delete env['ACDE_DEV']
console.log(`Sample files for the open dialogs: ${sample}`)
if (process.argv.includes('--prepare-only')) {
  console.log(`Prepared without starting the window: ${run}`)
  process.exit(0)
}
console.log('Close the window when done. Each button ends with a result line in the window.')
const child = Bun.spawn([binary, 'app', 'manual-file-chooser'], { env, stdout: 'inherit', stderr: 'inherit' })
process.exitCode = await child.exited
