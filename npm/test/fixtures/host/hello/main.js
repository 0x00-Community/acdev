console.log('hello ready')
const status = document.querySelector('#status')
const button = document.querySelector('#count')
let clicks = 0
button.addEventListener('click', () => {
  clicks += 1
  button.textContent = `Clicked ${clicks} times`
})
try {
  const answer = await (await fetch('/api/hello')).json()
  status.textContent = `backend says ${answer.hello}`
  console.log(`backend says ${answer.hello}`)
} catch (error) {
  status.textContent = `no backend: ${error.message}`
  console.error(`no backend: ${error.message}`)
}
