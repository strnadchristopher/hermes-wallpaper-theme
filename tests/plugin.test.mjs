import assert from 'node:assert/strict'
import { test } from 'node:test'

import plugin, {
  buildTheme,
  contrast,
  derivePalette,
  ensureContrast,
  loadPrefs,
  glassCSS,
  normalizeHex,
  PYWAL_PATH,
  readSource,
  resolveSourcePath,
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

test('source path priority: settings > config file > Pywal', () => {
  assert.deepEqual(resolveSourcePath('  ~/p.json ', { source: '~/c.json' }), { path: '~/p.json', origin: 'settings' })
  assert.deepEqual(resolveSourcePath('', { source: '~/c.json' }), { path: '~/c.json', origin: 'config' })
  assert.deepEqual(resolveSourcePath('', null), { path: PYWAL_PATH, origin: 'default' })
  assert.deepEqual(resolveSourcePath(undefined, { source: '' }), { path: PYWAL_PATH, origin: 'default' })
})

function fakeHost(files) {
  const contributions = new Map()
  const storage = new Map()
  const intervals = []
  globalThis.window = {
    hermesDesktop: {
      readFileText: async path => {
        if (!(path in files)) throw new Error('ENOENT')
        return { text: files[path] }
      }
    }
  }
  globalThis.localStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) }
  const ctx = {
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
  return { ctx, contributions, intervals, storage }
}

const settle = () => new Promise(r => setTimeout(r, 20))

test('register(): loads Pywal by default, repaints on change, keeps last good theme on a bad write', async () => {
  const files = { [PYWAL_PATH]: JSON.stringify(pywal) }
  const host = fakeHost(files)
  plugin.register(host.ctx)
  await settle()
  const first = host.contributions.get('theme').data
  assert.equal(first.name, THEME_NAME)

  files[PYWAL_PATH] = JSON.stringify({ ...pywal, special: { ...pywal.special, background: '#1d1020' } })
  await host.intervals[0]()
  await settle()
  const second = host.contributions.get('theme').data
  assert.equal(second.colors.background, '#1d1020')

  files[PYWAL_PATH] = '{"special": {'
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

test('prefs: defaults, round-trip and junk tolerance', () => {
  const mem = new Map()
  const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }
  assert.deepEqual(loadPrefs(store), { path: '', glass: false, opacity: 82 })
  mem.set('hermes-wallpaper-theme:prefs', JSON.stringify({ path: '~/x.json', glass: true, opacity: 500 }))
  assert.deepEqual(loadPrefs(store), { path: '~/x.json', glass: true, opacity: 82 })
  mem.set('hermes-wallpaper-theme:prefs', '{nope')
  assert.deepEqual(loadPrefs(store), { path: '', glass: false, opacity: 82 })
})
