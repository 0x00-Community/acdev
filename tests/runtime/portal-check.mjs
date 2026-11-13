// runtime's FileChooser as acde registers it: on a session bus without xdg-desktop-portal it does not open
// (`portal_unavailable`, which acde-host takes as a cancelled picker). The portal protocol itself (the options sent,
// the Response read, file:// URIs decoded, cancelling) is checked against a stand-in portal by
// `cargo test -p acde-runtime --lib portal`.
// Usage: portal-check.sh <acde>
import { Checks, failure, native } from './check.mjs'

const t = new Checks()
t.check('FileChooser is registered', typeof native.FileChooser?.open, 'function')
t.check('no portal: portal_unavailable', (await failure(native.FileChooser.open()))?.code, 'portal_unavailable')
t.done()
