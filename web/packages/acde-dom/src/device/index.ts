import { globals } from '../core/host'
import { Navigator } from '../dom/window'
import { Battery, BatteryManager, type BatteryNative } from './battery'

export type DeviceNative = BatteryNative

export function installDevice(global: object, native: DeviceNative | undefined): void {
  if (!native) return
  const battery = new Battery(native)
  Object.defineProperty(Navigator.prototype, 'getBattery', {
    value: function getBattery(this: Navigator) {
      return battery.get()
    },
    writable: true,
    configurable: true,
  })
  globals(global, { BatteryManager })
}
