import type { AppsChangedEvent, DesktopApp } from '@dopame/acde-api'

export interface AppListingHost {
  apps(): DesktopApp[]
  tell(event: AppsChangedEvent): void
}

export class AppListing {
  readonly #host: AppListingHost
  #known: string | null = null

  constructor(host: AppListingHost) {
    this.#host = host
  }

  list(): DesktopApp[] {
    const apps = this.#host.apps()
    this.#known = JSON.stringify(apps)
    return apps
  }

  changed(force = false): DesktopApp[] {
    const known = this.#known
    const apps = this.list()
    if (force || this.#known !== known) this.#host.tell({ type: 'appschanged', apps })
    return apps
  }
}
