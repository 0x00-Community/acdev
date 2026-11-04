const greeting = document.getElementById('greeting')!
const answer = await fetch('/api/hello')
greeting.textContent = `${await answer.text()} (${import.meta.env.MODE})`
const { decorate } = await import('./lazy.ts')
decorate(greeting)
