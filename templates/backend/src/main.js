import { locale, t, translate } from './i18n.js'

translate()
const answer = await (await fetch('/api/hello')).json()
const time = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(answer.at))
document.querySelector('#status').textContent = t('status', { language: navigator.language, time })
