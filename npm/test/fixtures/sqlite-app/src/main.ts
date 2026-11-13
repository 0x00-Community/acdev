export {}
const list = document.getElementById('notes')!
const notes = (await (await fetch('/api/notes')).json()) as { id: number; text: string }[]
for (const note of notes) list.append(Object.assign(document.createElement('li'), { textContent: note.text }))
