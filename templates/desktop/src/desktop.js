/// <reference types="@dopame/acde-api/shell" />
import { apps } from 'acde:apps'

const dock = /** @type {HTMLElement} */ (document.querySelector('#dock'))
for (const app of await apps.list()) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = app.label
  button.addEventListener('click', () => void apps.open(app.id))
  dock.append(button)
}
