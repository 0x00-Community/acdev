export function load(name) {
  const specifier = `acde:${name}`
  return import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ specifier).then(
    (module) => module.default ?? null,
    () => null,
  )
}
