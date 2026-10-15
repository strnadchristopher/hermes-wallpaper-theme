/**
 * Wallpaper Theme — a Hermes Desktop theme that follows your wallpaper.
 *
 * Reads a palette file on the machine running Desktop (Pywal's
 * ~/.cache/wal/colors.json by default), derives a readable theme from it and
 * repaints live whenever the file changes. Optional glass mode makes the app
 * background translucent so a compositor blur or native material shows through.
 *
 * Palette source, highest priority first:
 *   1. the path typed into Settings → Plugins → Wallpaper Theme
 *   2. "source" in ~/.config/hermes-wallpaper-theme/config.json (dotfile-friendly)
 *   3. ~/.cache/wal/colors.json (Pywal)
 *
 * Accepted file formats:
 *   - Pywal colors.json: { special: { background, foreground }, colors: { color0..color15 } }
 *   - A flat palette: { background, foreground, accent?, surface?, selection_text? }
 *     (WalGlass, matugen/wallust templates, or anything you write yourself)
 *
 * Plain ESM, loaded uncompiled. Imports only @hermes/plugin-sdk and react.
 */
import {
  atom,
  Button,
  Input,
  ListRow,
  PALETTE_AREA,
  requestTheme,
  THEMES_AREA,
  ToggleRow,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

export const PLUGIN_ID = 'wallpaper-theme'
export const THEME_NAME = 'wallpaper'
export const PYWAL_PATH = '~/.cache/wal/colors.json'
export const CONFIG_PATH = '~/.config/hermes-wallpaper-theme/config.json'
export const DEFAULT_GLASS_OPACITY = 82
const POLL_MS = 2000

// ---------------------------------------------------------------------------
// Color math (pure; no SDK so it is unit-testable in plain Node)
// ---------------------------------------------------------------------------

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i

export function normalizeHex(value) {
  if (typeof value !== 'string') {
    return null
  }

  const match = value.trim().match(HEX)

  if (!match) {
    return null
  }

  const raw = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1]

  return `#${raw.toLowerCase()}`
}

function rgb(hex) {
  const n = parseInt(hex.slice(1), 16)

  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]) {
  return `#${[r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`
}

export function mix(a, b, t) {
  const pa = rgb(a)
  const pb = rgb(b)

  return toHex(pa.map((v, i) => v + (pb[i] - v) * t))
}

export function luminance(hex) {
  const [r, g, b] = rgb(hex).map(v => {
    const c = v / 255

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function saturation(hex) {
  const [r, g, b] = rgb(hex).map(v => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) {
    return 0
  }

  return (max - min) / (1 - Math.abs(2 * l - 1))
}

/** Move `hex` toward black or white (whichever gains contrast) until it reaches `min` against `bg`. */
export function ensureContrast(hex, bg, min) {
  if (contrast(hex, bg) >= min) {
    return hex
  }

  const target = luminance(bg) < 0.18 ? '#ffffff' : '#000000'

  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = mix(hex, target, t)

    if (contrast(candidate, bg) >= min) {
      return candidate
    }
  }

  return target
}

/** Ink for text on a filled accent: near-black or white, whichever reads better. */
export function inkOn(fill) {
  return contrast('#0b0b0c', fill) >= contrast('#ffffff', fill) ? '#0b0b0c' : '#ffffff'
}

// ---------------------------------------------------------------------------
// Source parsing and palette derivation
// ---------------------------------------------------------------------------

/**
 * Turn a parsed JSON document into raw colors. Returns null for anything that
 * isn't a recognizable palette, so a half-written file never repaints the app.
 */
export function readSource(doc) {
  if (!doc || typeof doc !== 'object') {
    return null
  }

  // Pywal
  if (doc.special && doc.colors && typeof doc.colors === 'object') {
    const background = normalizeHex(doc.special.background)
    const foreground = normalizeHex(doc.special.foreground)
    const candidates = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14]
      .map(i => normalizeHex(doc.colors[`color${i}`]))
      .filter(Boolean)

    return background && foreground ? { format: 'pywal', background, foreground, candidates } : null
  }

  // Flat palette (WalGlass and friends)
  const background = normalizeHex(doc.background)
  const foreground = normalizeHex(doc.foreground)

  if (!background || !foreground) {
    return null
  }

  return {
    format: 'flat',
    background,
    foreground,
    surface: normalizeHex(doc.surface) ?? undefined,
    accent: normalizeHex(doc.accent) ?? undefined,
    selectionText: normalizeHex(doc.selection_text ?? doc.selectionText) ?? undefined,
    candidates: []
  }
}

function pickAccent(background, candidates, fallback) {
  const readable = candidates.filter(c => contrast(c, background) >= 3)
  const pool = readable.length ? readable : candidates

  if (!pool.length) {
    return ensureContrast(fallback, background, 3)
  }

  const best = pool.reduce((a, b) => (saturation(b) > saturation(a) ? b : a))

  return ensureContrast(best, background, 3)
}

/** Raw colors → a readable palette: body text ≥ 7:1, accents ≥ 3:1, ink on accent ≥ 4.5:1. */
export function derivePalette(source) {
  const background = source.background
  const dark = luminance(background) < 0.18
  const foreground = ensureContrast(source.foreground, background, 7)
  const surface = source.surface ?? mix(background, foreground, dark ? 0.07 : 0.05)
  const accent = source.accent
    ? ensureContrast(source.accent, background, 3)
    : pickAccent(background, source.candidates, mix(background, foreground, 0.6))
  const onAccent =
    source.selectionText && contrast(source.selectionText, accent) >= 4.5 ? source.selectionText : inkOn(accent)

  return {
    dark,
    background,
    surface,
    foreground: ensureContrast(foreground, surface, 7),
    accent,
    onAccent,
    muted: ensureContrast(mix(foreground, surface, 0.32), surface, 4.5)
  }
}

const SEMANTIC = { red: '#ef5350', green: '#22c55e', yellow: '#f59e0b' }

export function glassCSS(opacity) {
  const pct = Math.min(100, Math.max(30, Math.round(opacity)))

  // One translucent field painter (body); shells stay clear so the fills don't
  // stack back into an opaque color. Raised surfaces, masks and selection keep
  // solid fills, and text never fades.
  return `
:root {
  background-color: transparent !important;
  --ui-chat-surface-background: transparent;
  --ui-sidebar-surface-background: transparent;
  --ui-editor-surface-background: transparent;
  --ui-terminal-surface-background: var(--theme-background-seed);
}
:root body { background: color-mix(in srgb, var(--theme-background-seed) ${pct}%, transparent); }
:root [data-contrib-shell], :root [data-slot='sidebar-wrapper'] { background-color: transparent !important; }
:root :is([data-glass-opaque], [data-glass-raised]) {
  --ui-chat-surface-background: var(--theme-background-seed);
  --ui-sidebar-surface-background: var(--theme-sidebar-seed);
  --ui-editor-surface-background: var(--theme-background-seed);
}
:root ::selection { color: var(--dt-primary-foreground); background: var(--theme-primary); }
`
}

export function buildTheme(palette, { glass = false, opacity = DEFAULT_GLASS_OPACITY } = {}) {
  const { surface, foreground, accent, onAccent, muted, background } = palette
  const border = mix(surface, foreground, 0.18)
  const softAccent = mix(surface, accent, 0.2)

  const colors = {
    background,
    foreground,
    card: surface,
    cardForeground: foreground,
    muted: mix(surface, background, 0.45),
    mutedForeground: muted,
    popover: surface,
    popoverForeground: foreground,
    primary: accent,
    primaryForeground: onAccent,
    secondary: mix(surface, accent, 0.12),
    secondaryForeground: foreground,
    accent: softAccent,
    accentForeground: foreground,
    border,
    input: border,
    ring: accent,
    midground: accent,
    midgroundForeground: onAccent,
    composerRing: accent,
    destructive: SEMANTIC.red,
    destructiveForeground: '#ffffff',
    sidebarBackground: surface,
    sidebarBorder: border,
    userBubble: softAccent,
    userBubbleBorder: border
  }

  const terminal = {
    foreground,
    cursor: foreground,
    selectionBackground: accent,
    blue: accent,
    cyan: mix(accent, SEMANTIC.green, 0.35),
    ...SEMANTIC
  }

  return {
    name: THEME_NAME,
    label: 'Wallpaper',
    description: 'Follows your wallpaper palette live',
    colors,
    darkColors: colors,
    terminal,
    darkTerminal: terminal,
    ...(glass ? { customCSS: glassCSS(opacity) } : {})
  }
}

/** Settings path > config-file path > Pywal. Blank strings fall through. */
export function resolveSourcePath(settingsPath, config) {
  const fromSettings = typeof settingsPath === 'string' ? settingsPath.trim() : ''

  if (fromSettings) {
    return { path: fromSettings, origin: 'settings' }
  }

  const fromConfig = config && typeof config.source === 'string' ? config.source.trim() : ''

  return fromConfig ? { path: fromConfig, origin: 'config' } : { path: PYWAL_PATH, origin: 'default' }
}

// ---------------------------------------------------------------------------
// Desktop wiring
// ---------------------------------------------------------------------------

async function readLocalText(path) {
  const bridge = typeof window !== 'undefined' ? window.hermesDesktop : undefined

  if (!bridge?.readFileText) {
    throw new Error('This Hermes Desktop build cannot read local files from plugins.')
  }

  const result = await bridge.readFileText(path)

  if (!result || typeof result.text !== 'string') {
    throw new Error('No readable text at that path.')
  }

  return result.text
}

async function readConfig() {
  try {
    return JSON.parse(await readLocalText(CONFIG_PATH))
  } catch {
    return null
  }
}

const PREFS_KEY = 'hermes-wallpaper-theme:prefs'

/** Per-install settings in the renderer's localStorage (the plugin SDK has no storage API). */
export function loadPrefs(store = globalThis.localStorage) {
  const defaults = { path: '', glass: false, opacity: DEFAULT_GLASS_OPACITY }

  try {
    const raw = JSON.parse(store?.getItem(PREFS_KEY) ?? 'null')

    if (!raw || typeof raw !== 'object') {
      return defaults
    }

    const opacity = Number(raw.opacity)

    return {
      path: typeof raw.path === 'string' ? raw.path : '',
      glass: raw.glass === true,
      opacity: Number.isFinite(opacity) && opacity >= 30 && opacity <= 100 ? opacity : DEFAULT_GLASS_OPACITY
    }
  } catch {
    return defaults
  }
}

function savePrefs(prefs, store = globalThis.localStorage) {
  try {
    store?.setItem(PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // Storage full or unavailable: the setting still applies for this session.
  }
}

const $status = atom({ state: 'loading', path: PYWAL_PATH, origin: 'default', message: '', format: '' })
const $prefs = atom({ path: '', glass: false, opacity: DEFAULT_GLASS_OPACITY })

function SettingsPage({ save, refresh }) {
  const status = useValue($status)
  const prefs = useValue($prefs)
  const [draft, setDraft] = useState(prefs.path)
  const stateLine =
    status.state === 'ok'
      ? `Live from ${status.path} (${status.format === 'pywal' ? 'Pywal' : 'flat palette'}).`
      : status.state === 'loading'
        ? 'Reading palette…'
        : `Not loaded: ${status.message}`

  return jsxs('div', {
    className: 'flex flex-col',
    children: [
      jsx(ListRow, {
        title: 'Palette file',
        description: jsxs('span', {
          children: [
            'Leave blank to use ',
            jsx('code', { children: status.origin === 'config' ? 'the config file' : 'Pywal' }),
            '. Pywal is ~/.cache/wal/colors.json; a flat JSON with background, foreground and accent also works.'
          ]
        }),
        hint: stateLine,
        below: jsxs('div', {
          className: 'flex gap-2',
          children: [
            jsx(Input, {
              value: draft,
              placeholder: status.origin === 'config' ? status.path : PYWAL_PATH,
              onChange: event => setDraft(event.target.value),
              onKeyDown: event => event.key === 'Enter' && save({ path: draft })
            }),
            jsx(Button, { onClick: () => save({ path: draft }), children: 'Save' }),
            jsx(Button, { variant: 'ghost', onClick: refresh, children: 'Reload' })
          ]
        })
      }),
      jsx(ToggleRow, {
        label: 'Glass background',
        description:
          'Make the app background translucent so a blurred desktop shows through. Needs a transparent window: macOS/Windows translucency, or on Linux a compositor with blur and HERMES_DESKTOP_TRANSPARENT=1.',
        checked: prefs.glass,
        onChange: on => save({ glass: on })
      }),
      prefs.glass
        ? jsx(ListRow, {
            title: 'Glass opacity',
            description: 'How much of the theme color covers the blur (30–100%).',
            action: jsx(Input, {
              type: 'number',
              min: 30,
              max: 100,
              value: String(prefs.opacity),
              className: 'w-20',
              onChange: event => {
                const n = Number(event.target.value)

                if (Number.isFinite(n) && n >= 30 && n <= 100) {
                  save({ opacity: n })
                }
              }
            })
          })
        : null,
      jsx(ListRow, {
        title: 'Use the Wallpaper theme',
        description: 'Switch to it now. It also appears in the normal theme picker.',
        action: jsx(Button, { onClick: () => requestTheme(THEME_NAME), children: 'Apply' })
      })
    ]
  })
}

const plugin = {
  id: PLUGIN_ID,
  name: 'Wallpaper Theme',
  description: 'A theme that follows your wallpaper palette (Pywal or any palette file), with optional glass.',
  register(ctx) {
    $prefs.set(loadPrefs())

    let lastKey = ''
    let disposeTheme = null
    let busy = false

    const tick = async (force = false) => {
      if (busy) {
        return
      }

      busy = true

      try {
        const prefs = $prefs.get()
        const { path, origin } = resolveSourcePath(prefs.path, prefs.path ? null : await readConfig())
        let text

        try {
          text = await readLocalText(path)
        } catch (error) {
          $status.set({ state: 'error', path, origin, format: '', message: error?.message || String(error) })

          return
        }

        const key = `${path}\n${prefs.glass}\n${prefs.opacity}\n${text}`

        if (!force && key === lastKey) {
          return
        }

        let source = null

        try {
          source = readSource(JSON.parse(text))
        } catch {
          source = null
        }

        if (!source) {
          // Keep the last good theme; a writer may be mid-save.
          $status.set({ state: 'error', path, origin, format: '', message: 'not a Pywal or flat palette JSON' })

          return
        }

        lastKey = key
        const theme = buildTheme(derivePalette(source), prefs)
        // Same tick, before React renders: the picker never sees the theme missing.
        disposeTheme?.()
        disposeTheme = ctx.register({ id: 'theme', area: THEMES_AREA, data: theme })
        $status.set({ state: 'ok', path, origin, format: source.format, message: '' })
      } finally {
        busy = false
      }
    }

    const save = patch => {
      const next = { ...$prefs.get(), ...patch }
      next.path = (next.path || '').trim()
      $prefs.set(next)
      savePrefs(next)
      void tick(true)
    }

    ctx.onDispose(() => disposeTheme?.())
    ctx.setInterval(() => void tick(), POLL_MS)
    void tick(true)

    ctx.register({
      id: 'apply',
      area: PALETTE_AREA,
      data: {
        id: 'wallpaper-theme.apply',
        label: 'Theme: use Wallpaper',
        keywords: ['wallpaper', 'pywal', 'theme', 'palette', 'glass'],
        run: () => requestTheme(THEME_NAME)
      }
    })

    ctx.registerSettingsPage?.({
      id: 'settings',
      title: 'Wallpaper Theme',
      icon: 'symbol-color',
      render: () => jsx(SettingsPage, { save, refresh: () => void tick(true) })
    })
  }
}

export default plugin
