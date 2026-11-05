const status = document.querySelector('#status')
const answer = await (await fetch('/api/hello')).json()
status.textContent = `${answer.hello} · ${navigator.language} · ${answer.at}`
