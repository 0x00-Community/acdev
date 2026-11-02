#!/usr/bin/env dash
# Run atspi-check.mjs under acde on a private session bus (dbus-run-session; at-spi is activated from the installed
# service files) next to two test windows that need no display: GTK 3 on broadway (python-gobject, broadwayd) and
# Qt Quick (qml6) on a virtual KWin (kwin_wayland --virtual; Qt's offscreen platform has no AT-SPI bridge). Their
# pids go to the check as ATSPI_GTK_PID / ATSPI_QT_PID; a toolkit that is not installed is skipped. Scratch files in a fresh directory under $ACDE_CHECK_TMP (default: $TMPDIR, else /tmp).
# Usage: crates/runtime/tests/atspi-check.sh <acde binary>
set -eu
if [ "${1:-}" != --inside ]; then
  acde=$(realpath "$1")
  exec dbus-run-session -- dash "$(realpath "$0")" --inside "$acde"
fi
acde=$2
here=$(dirname "$(realpath "$0")")
dir=$(mktemp -d "${ACDE_CHECK_TMP:-${TMPDIR:-/tmp}}/acde-atspi.XXXXXX")
pids=
trap 'for p in $pids; do kill "$p" 2>/dev/null || true; done; rm -rf "$dir"' EXIT

cat > "$dir/gtk.py" <<'PY'
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk
window = Gtk.Window(title='acde gtk check')
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
label = Gtk.Label(label='pressed 0')
entry = Gtk.Entry()
check = Gtk.CheckButton(label='Remember')
button = Gtk.Button(label='Press me')
presses = [0]
def pressed(_):
    presses[0] += 1
    label.set_text(f'pressed {presses[0]}')
button.connect('clicked', pressed)
for widget in (label, entry, check, button):
    box.add(widget)
window.add(box)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
PY

cat > "$dir/qt.qml" <<'QML'
import QtQuick
import QtQuick.Controls
ApplicationWindow {
  visible: true
  title: "acde qt check"
  width: 320
  height: 240
  property int presses: 0
  Column {
    Label { text: "pressed " + presses }
    TextField { placeholderText: "name" }
    CheckBox { text: "Remember" }
    Button { text: "Press me"; onClicked: presses++ }
  }
}
QML

export ATSPI_GTK_PID= ATSPI_QT_PID=
if command -v broadwayd >/dev/null && python3 -c 'import gi; gi.require_version("Gtk", "3.0")' 2>/dev/null; then
  broadwayd :7 >"$dir/broadwayd.log" 2>&1 &
  pids="$pids $!"
  sleep 0.5
  GDK_BACKEND=broadway BROADWAY_DISPLAY=:7 python3 "$dir/gtk.py" >"$dir/gtk.log" 2>&1 &
  ATSPI_GTK_PID=$!
  pids="$pids $!"
fi
if command -v qml6 >/dev/null && command -v kwin_wayland >/dev/null; then
  kwin_wayland --virtual --socket acde-atspi-check --no-lockscreen --width 1280 --height 800 >"$dir/kwin.log" 2>&1 &
  pids="$pids $!"
  sleep 2
  WAYLAND_DISPLAY=acde-atspi-check QT_QPA_PLATFORM=wayland QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1 qml6 "$dir/qt.qml" >"$dir/qt.log" 2>&1 &
  ATSPI_QT_PID=$!
  pids="$pids $!"
fi
"$here/run.sh" "$acde" "$here/atspi-check.mjs"
