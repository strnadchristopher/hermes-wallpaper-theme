// Minimal stand-in for @hermes/plugin-sdk so the plugin's pure functions and
// register() wiring can run under plain Node.
export const THEMES_AREA = 'themes'
export const PALETTE_AREA = 'palette'

export function atom(value) {
  const subs = new Set()

  return {
    get: () => value,
    set(next) {
      value = next
      subs.forEach(fn => fn(value))
    },
    subscribe(fn) {
      subs.add(fn)
      fn(value)

      return () => subs.delete(fn)
    }
  }
}

export const requested = []
export function requestTheme(name) {
  requested.push(name)

  return true
}

export const useValue = store => store.get()
export const Button = () => null
export const Input = () => null
export const ListRow = () => null
export const ToggleRow = () => null
