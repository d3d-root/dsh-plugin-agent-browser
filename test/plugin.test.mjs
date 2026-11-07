// РџСЂРѕРІРµСЂРєР°, С‡С‚Рѕ РїР»Р°РіРёРЅ СЃРѕР±РёСЂР°РµС‚СЃСЏ Рё СЂРµРіРёСЃС‚СЂРёСЂСѓРµС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹.
//
// apply() Р·Р°РїСѓСЃРєР°РµС‚СЃСЏ РЅР° РїРѕРґРґРµР»СЊРЅРѕРј РєРѕРЅС‚РµРєСЃС‚Рµ Cordis: РЅР°СЃС‚РѕСЏС‰РёР№ С‚СЂРµР±СѓРµС‚
// СЃРµСЂРІРёСЃРѕРІ DSH, РєРѕС‚РѕСЂС‹С… РІ С‚РµСЃС‚Рµ РЅРµС‚. РџСЂРѕРІРµСЂСЏРµРј С‚Рѕ, С‡С‚Рѕ С‡Р°С‰Рµ РІСЃРµРіРѕ Р»РѕРјР°РµС‚СЃСЏ РїСЂРё
// РїСЂР°РІРєР°С…: СЃРїРёСЃРѕРє РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ, РёС… РїР°СЂР°РјРµС‚СЂС‹ Рё С‚Рѕ, С‡С‚Рѕ РЅРё РѕРґРёРЅ РЅРµ Р±СЂРѕСЃР°РµС‚
// РёСЃРєР»СЋС‡РµРЅРёРµ РїСЂРё СЃР±РѕСЂРєРµ.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * РќР°СЃС‚СЂРѕР№РєРё РґР»СЏ С‚РµСЃС‚РѕРІ: СЃРІРѕР№ Р¶СѓСЂРЅР°Р» РІРѕ РІСЂРµРјРµРЅРЅРѕР№ РїР°РїРєРµ.
 *
 * Р‘РµР· СЌС‚РѕРіРѕ apply() РїРёС€РµС‚ РІ РѕР±С‰РёР№ Р¶СѓСЂРЅР°Р» РїР»Р°РіРёРЅР°, Рё С‚РµСЃС‚С‹ Р·Р°СЃРѕСЂСЏСЋС‚ РґРёР°РіРЅРѕСЃС‚РёРєСѓ
 * РЅР°СЃС‚РѕСЏС‰РµР№ СѓСЃС‚Р°РЅРѕРІРєРё вЂ” РІ РЅС‘Рј РїРѕСЏРІР»СЏСЋС‚СЃСЏ С‡СѓР¶РёРµ СЃС‚СЂРѕРєРё В«apply() РЅР°С‡Р°С‚В».
 */
const TEST_CONFIG = { debug: false, logFile: join(tmpdir(), 'dsh-agent-browser-test.log') }

/** РњРёРЅРёРјР°Р»СЊРЅС‹Р№ РєРѕРЅС‚РµРєСЃС‚: С‚РѕР»СЊРєРѕ С‚Рѕ, С‡С‚Рѕ СЂРµР°Р»СЊРЅРѕ РёСЃРїРѕР»СЊР·СѓРµС‚ РїР»Р°РіРёРЅ. */
function fakeContext() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    tools: {
      register(tool) {
        registered.push(tool)
      },
    },
    reflect: { get: () => undefined },
    effect(fn, label) {
      effects.push(label)
      try {
        return fn()
      } catch {
        return () => {}
      }
    },
    on() {},
    logger: { info() {}, warn() {}, error() {} },
  }
}

test('apply СЂРµРіРёСЃС‚СЂРёСЂСѓРµС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ Рё РЅРµ РїР°РґР°РµС‚', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  assert.ok(ctx.registered.length >= 30, `РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ ${ctx.registered.length}, РѕР¶РёРґР°Р»РѕСЃСЊ РЅРµ РјРµРЅСЊС€Рµ 30`)
})

test('Сѓ РєР°Р¶РґРѕРіРѕ РёРЅСЃС‚СЂСѓРјРµРЅС‚Р° РµСЃС‚СЊ РёРјСЏ, РѕРїРёСЃР°РЅРёРµ Рё РѕР±СЂР°Р±РѕС‚С‡РёРє', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.name.startsWith('browser_'), `СЃС‚СЂР°РЅРЅРѕРµ РёРјСЏ: ${tool.name}`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `РїСѓСЃС‚РѕРµ РѕРїРёСЃР°РЅРёРµ Сѓ ${tool.name}`)
    // DSH РїСЂРёРЅРёРјР°РµС‚ `run` Рё С…СЂР°РЅРёС‚ РµРіРѕ РєР°Рє `execute`: РїСЂРѕРІРµСЂСЏРµРј РѕР±Р° РІР°СЂРёР°РЅС‚Р°,
    // С‡С‚РѕР±С‹ С‚РµСЃС‚ РЅРµ Р·Р°РІРёСЃРµР» РѕС‚ С‚РѕРіРѕ, РіРґРµ РёРјРµРЅРЅРѕ РїСЂРѕРёР·РѕС€Р»Рѕ РїРµСЂРµРёРјРµРЅРѕРІР°РЅРёРµ.
    const handler = tool.execute || tool.run
    assert.equal(typeof handler, 'function', `Сѓ ${tool.name} РЅРµС‚ РѕР±СЂР°Р±РѕС‚С‡РёРєР°`)
    assert.equal(typeof tool.parameters, 'object')
  }
})

test('РёРјРµРЅР° РёРЅСЃС‚СЂСѓРјРµРЅС‚РѕРІ РЅРµ РїРѕРІС‚РѕСЂСЏСЋС‚СЃСЏ', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  const names = ctx.registered.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, 'РµСЃС‚СЊ РїРѕРІС‚РѕСЂСЏСЋС‰РёРµСЃСЏ РёРјРµРЅР°')
})

test('РІСЃРµ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ РїСЂРёРЅРёРјР°СЋС‚ tabId вЂ” Р°РґСЂРµСЃР°С†РёСЏ РІРєР»Р°РґРєРё', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  for (const tool of ctx.registered) {
    assert.ok(tool.parameters.tabId, `Сѓ ${tool.name} РЅРµС‚ tabId`)
    assert.equal(tool.parameters.tabId.type, 'string')
  }
})

test('РЅРѕРІС‹Рµ РёРЅСЃС‚СЂСѓРјРµРЅС‚С‹ 1.1.0 РїСЂРёСЃСѓС‚СЃС‚РІСѓСЋС‚', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  const names = new Set(ctx.registered.map((t) => t.name))
  for (const expected of [
    'browser_upload',
    'browser_download',
    'browser_extract',
    'browser_find_all',
    'browser_click_index',
    'browser_pdf',
    'browser_zoom',
    'browser_find_in_page',
    'browser_save_session',
    'browser_restore_session',
    'browser_storage_clear',
    'browser_page_state',
    'browser_trace',
  ]) {
    assert.ok(names.has(expected), `РЅРµС‚ РёРЅСЃС‚СЂСѓРјРµРЅС‚Р° ${expected}`)
  }
})

test('РѕР±СЏР·Р°С‚РµР»СЊРЅС‹Рµ РїР°СЂР°РјРµС‚СЂС‹ РїРѕРјРµС‡РµРЅС‹ РєР°Рє required', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  const byName = new Map(ctx.registered.map((t) => [t.name, t]))
  assert.equal(byName.get('browser_upload').parameters.files.required, true)
  assert.equal(byName.get('browser_download').parameters.url.required, true)
  assert.equal(byName.get('browser_extract').parameters.selector.required, true)
  assert.equal(byName.get('browser_click_index').parameters.index.required, true)
  assert.equal(byName.get('browser_zoom').parameters.factor.required, true)
})
