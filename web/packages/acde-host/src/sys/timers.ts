export function unref<T>(handle: T): T {
  ;(handle as { unref?: () => void }).unref?.()
  return handle
}

export function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<T>((resolve) => (timer = unref(setTimeout(() => resolve(fallback), ms))))
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
