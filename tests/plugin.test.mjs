import assert from 'node:assert/strict'
import { test } from 'node:test'

import plugin, {
  buildTheme,
  contrast,
  derivePalette,
  ensureContrast,
  BACKEND_OFF_MESSAGE,
  describeRestError,
  normalizePrefs,
  glassCSS,
  normalizeHex,
  PYWAL_PATH,
  readSource,
  THEME_NAME
} from '../desktop/plugin.js'
import { requested } from './sdk-stub.mjs'

const pywal = {
  wallpaper: '/tmp/wall.jpg',
  special: { background: '#0f1417', foreground: '#c3c5c7', cursor: '#c3c5c7' },
  colors: Object.fromEntries(
    ['#0f1417', '#3b4a52', '#56707a', '#a0603a', '#6f8a5c', '#7d6aa0', '#5d8fa3', '#c3c5c7',
     '#888a8b', '#3b4a52', '#56707a', '#a0603a', '#6f8a5c', '#7d6aa0', '#5d8fa3', '#c3c5c7'].map((c, i) => [`color${i}`, c])
  )
}

const walglass = {
  background: '#151817', surface: '#252927', foreground: '#f5f6f8', accent: '#b4c3be',
  selection_text: '#06090a', selection_contrast: 10.93, worst_case_body_contrast: 9.43
}

test('normalizeHex accepts 3/6 digit hex with or without #, rejects junk', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc')
  assert.equal(normalizeHex('a1b2c3'), '#a1b2c3')
  assert.equal(normalizeHex('rgb(0,0,0)'), null)
  assert.equal(normalizeHex(42), null)
})

test('reads Pywal colors.json', () => {
  const src = readSource(pywal)
  assert.equal(src.format, 'pywal')
  assert.equal(src.background, '#0f1417')
  assert.equal(src.candidates.length, 12)
})

test('reads a flat WalGlass palette and keeps its tuned colors', () => {
  const src = readSource(walglass)
  assert.equal(src.format, 'flat')
  const p = derivePalette(src)
  assert.equal(p.background, '#151817')
  assert.equal(p.surface, '#252927')
  assert.equal(p.accent, '#b4c3be')
  assert.equal(p.onAccent, '#06090a')
})

test('rejects partial or unrelated JSON', () => {
  assert.equal(readSource({}), null)
  assert.equal(readSource({ background: '#000000' }), null)
  assert.equal(readSource({ special: { background: 'nope', foreground: '#fff' }, colors: {} }), null)
  assert.equal(readSource(null), null)
})

test('derived palettes are readable for dark, light and low-contrast wallpapers', () => {
  const cases = [
    pywal,
    { special: { background: '#f4efe6', foreground: '#5a5048' }, colors: { color1: '#e8d9c0', color2: '#d9c7a8', color4: '#c97b4a' } },
    { special: { background: '#202020', foreground: '#333333' }, colors: { color1: '#262626', color2: '#2a2a2a' } }
  ]

  for (const doc of cases) {
    const p = derivePalette(readSource(doc))
    assert.ok(contrast(p.foreground, p.background) >= 7, `body text ${p.foreground} on ${p.background}`)
    assert.ok(contrast(p.foreground, p.surface) >= 7, 'body text on surface')
    assert.ok(contrast(p.accent, p.background) >= 3, `accent ${p.accent} on ${p.background}`)
    assert.ok(contrast(p.onAccent, p.accent) >= 4.5, 'ink on accent')
    assert.ok(contrast(p.muted, p.surface) >= 4.5, 'muted text on surface')
  }
})

test('picks a saturated accent rather than a grey', () => {
  const p = derivePalette(readSource(pywal))
  assert.notEqual(p.accent, '#888a8b')
  assert.notEqual(p.accent, '#c3c5c7')
})

test('ensureContrast leaves good pairs alone and fixes bad ones', () => {
  assert.equal(ensureContrast('#ffffff', '#000000', 7), '#ffffff')
  assert.ok(contrast(ensureContrast('#222222', '#111111', 4.5), '#111111') >= 4.5)
})

test('theme has the name, required colors and glass CSS only when asked', () => {
  const p = derivePalette(readSource(pywal))
  const plain = buildTheme(p)
  assert.equal(plain.name, THEME_NAME)
  for (const key of ['background', 'foreground', 'primary']) assert.match(plain.colors[key], /^#[0-9a-f]{6}$/)
  assert.equal(plain.customCSS, undefined)
  const glass = buildTheme(p, { glass: true, opacity: 70 })
  assert.match(glass.customCSS, /70%, transparent/)
  assert.doesNotMatch(glass.customCSS, /opacity:/, 'never fades whole surfaces')
  assert.match(glassCSS(5), /30%/, 'opacity is clamped')
})

test('describeRestError: a 404 from ctx.rest means the backend is not enabled', () => {
  assert.equal(describeRestError(Object.assign(new Error('404: not found'), { statusCode: 404 })), BACKEND_OFF_MESSAGE)
  assert.equal(describeRestError(new Error('404: {"detail":"Not Found"}')), BACKEND_OFF_MESSAGE)
  assert.equal(describeRestError(new Error('socket hang up')), 'socket hang up')
})

const CONFIG_PATH = '~/.config/hermes-wallpaper-theme/config.json'

/**
 * Stand-in for dashboard/plugin_api.py: same resolution order, same reply
 * shape, same `since` short-circuit. `files` maps a path to its text; a
 * "version" per path plays the role of mtime. Set `host.down` to make
 * ctx.rest throw like an unmounted backend.
 */
function fakeHost(files) {
  const contributions = new Map()
  const storage = new Map()
  const intervals = []
  const versions = new Map()
  const calls = []
  const host = { down: false }

  const stampOf = path => `${path}:${versions.get(path) ?? 0}:${files[path].length}`

  const palette = params => {
    const settings = (params.get('path') || '').trim()
    let config = null

    if (!settings && CONFIG_PATH in files) {
      try {
        config = JSON.parse(files[CONFIG_PATH])
      } catch {
        config = null
      }
    }

    const fromConfig = typeof config?.source === 'string' ? config.source.trim() : ''
    const [path, origin] = settings ? [settings, 'settings'] : fromConfig ? [fromConfig, 'config'] : [PYWAL_PATH, 'default']

    if (!(path in files)) {
      return { ok: false, path, origin, error: 'no such file' }
    }

    const stamp = stampOf(path)

    if (params.get('since') === stamp) {
      return { ok: true, unchanged: true, stamp, path, origin }
    }

    try {
      return { ok: true, stamp, path, origin, palette: JSON.parse(files[path]) }
    } catch {
      return { ok: false, path, origin, error: 'not valid JSON' }
    }
  }

  const ctx = {
    storage: { get: (k, d) => (storage.has(k) ? storage.get(k) : d), set: (k, v) => storage.set(k, v), remove: k => storage.delete(k) },
    async rest(route) {
      calls.push(route)

      if (host.down) {
        throw Object.assign(new Error('404: {"detail":"Not Found"}'), { statusCode: 404 })
      }

      const [pathname, search = ''] = route.split('?')
      assert.equal(pathname, '/palette')

      return palette(new URLSearchParams(search))
    },
    register(c) {
      contributions.set(c.id, c)
      return () => contributions.delete(c.id)
    },
    registerSettingsPage: () => () => {},
    onDispose() {},
    setInterval(fn) {
      intervals.push(fn)
      return () => {}
    }
  }

  const write = (path, text) => {
    files[path] = text
    versions.set(path, (versions.get(path) ?? 0) + 1)
  }

  return Object.assign(host, { ctx, contributions, intervals, storage, calls, write })
}

const settle = () => new Promise(r => setTimeout(r, 20))

test('register(): loads Pywal by default, repaints on change, keeps last good theme on a bad write', async () => {
  const files = { [PYWAL_PATH]: JSON.stringify(pywal) }
  const host = fakeHost(files)
  plugin.register(host.ctx)
  await settle()
  const first = host.contributions.get('theme').data
  assert.equal(first.name, THEME_NAME)

  // An unchanged file is answered from the stamp: no palette on the wire, no repaint.
  await host.intervals[0]()
  await settle()
  assert.match(host.calls.at(-1), /since=/)
  assert.equal(host.contributions.get('theme').data, first)

  host.write(PYWAL_PATH, JSON.stringify({ ...pywal, special: { ...pywal.special, background: '#1d1020' } }))
  await host.intervals[0]()
  await settle()
  const second = host.contributions.get('theme').data
  assert.equal(second.colors.background, '#1d1020')

  host.write(PYWAL_PATH, '{"special": {')
  await host.intervals[0]()
  await settle()
  assert.equal(host.contributions.get('theme').data.colors.background, '#1d1020')

  host.contributions.get('apply').data.run()
  assert.equal(requested.at(-1), THEME_NAME)
})

test('register(): the config file path overrides Pywal', async () => {
  const files = {
    [PYWAL_PATH]: JSON.stringify(pywal),
    '~/.config/hermes-wallpaper-theme/config.json': JSON.stringify({ source: '~/.local/share/wal-glass/palette.json' }),
    '~/.local/share/wal-glass/palette.json': JSON.stringify(walglass)
  }
  const host = fakeHost(files)
  plugin.register(host.ctx)
  await settle()
  assert.equal(host.contributions.get('theme').data.colors.background, '#151817')
})

test('prefs: defaults, valid values and junk tolerance', () => {
  assert.deepEqual(normalizePrefs(null), { path: '', glass: false, opacity: 82 })
  assert.deepEqual(normalizePrefs({ path: '~/x.json', glass: true, opacity: 60 }), { path: '~/x.json', glass: true, opacity: 60 })
  assert.deepEqual(normalizePrefs({ path: 5, glass: 'yes', opacity: 500 }), { path: '', glass: false, opacity: 82 })
})

test('register(): settings path is restored from plugin storage', async () => {
  const files = { [PYWAL_PATH]: JSON.stringify(pywal), '~/mine.json': JSON.stringify(walglass) }
  const host = fakeHost(files)
  host.storage.set('prefs', { path: '~/mine.json', glass: true, opacity: 70 })
  plugin.register(host.ctx)
  await settle()
  const theme = host.contributions.get('theme').data
  assert.equal(theme.colors.background, '#151817')
  assert.match(theme.customCSS, /70%, transparent/)
})

test('register(): an unmounted backend reports how to enable it and recovers once it answers', async () => {
  const host = fakeHost({ [PYWAL_PATH]: JSON.stringify(pywal) })
  host.down = true
  plugin.register(host.ctx)
  await settle()
  assert.equal(host.contributions.has('theme'), false)

  host.down = false
  await host.intervals[0]()
  await settle()
  assert.equal(host.contributions.get('theme').data.colors.background, '#0f1417')
})

test('register(): the plugin never touches the Desktop bridge', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../desktop/plugin.js', import.meta.url), 'utf8'))
  assert.doesNotMatch(source, /hermesDesktop|readFileText|window\./)
})
