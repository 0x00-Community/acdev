console.log('hello ready')
const status = document.querySelector('#status')
try {
  const answer = await (await fetch('/api/hello')).json()
  status.textContent = `backend says ${answer.hello}`
  console.log(`backend says ${answer.hello}`)
} catch (error) {
  status.textContent = `no backend: ${error.message}`
  console.error(`no backend: ${error.message}`)
}
