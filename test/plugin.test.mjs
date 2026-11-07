// Проверка, что плагин собирается и регистрирует инструменты.
//
// apply() запускается на поддельном контексте Cordis: настоящий требует
// сервисов DSH, которых в тесте нет. Проверяем то, что чаще всего ломается при
// правках: список инструментов, их параметры и то, что ни один не бросает
// исключение при сборке.

import { test } from 'node:test'
import assert from 'node:assert/strict'

/** Минимальный контекст: только то, что реально использует плагин. */
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

test('apply регистрирует инструменты и не падает', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
  assert.ok(ctx.registered.length >= 30, `инструментов ${ctx.registered.length}, ожидалось не меньше 30`)
})

test('у каждого инструмента есть имя, описание и обработчик', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
  for (const tool of ctx.registered) {
    assert.equal(typeof tool.name, 'string')
    assert.ok(tool.name.startsWith('browser_'), `странное имя: ${tool.name}`)
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length > 20, `пустое описание у ${tool.name}`)
    // DSH принимает `run` и хранит его как `execute`: проверяем оба варианта,
    // чтобы тест не зависел от того, где именно произошло переименование.
    const handler = tool.execute || tool.run
    assert.equal(typeof handler, 'function', `у ${tool.name} нет обработчика`)
    assert.equal(typeof tool.parameters, 'object')
  }
})

test('имена инструментов не повторяются', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
  const names = ctx.registered.map((t) => t.name)
  assert.equal(new Set(names).size, names.length, 'есть повторяющиеся имена')
})

test('все инструменты принимают tabId — адресация вкладки', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
  for (const tool of ctx.registered) {
    assert.ok(tool.parameters.tabId, `у ${tool.name} нет tabId`)
    assert.equal(tool.parameters.tabId.type, 'string')
  }
})

test('новые инструменты 1.1.0 присутствуют', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
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
    assert.ok(names.has(expected), `нет инструмента ${expected}`)
  }
})

test('обязательные параметры помечены как required', async () => {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, { debug: false })
  const byName = new Map(ctx.registered.map((t) => [t.name, t]))
  assert.equal(byName.get('browser_upload').parameters.files.required, true)
  assert.equal(byName.get('browser_download').parameters.url.required, true)
  assert.equal(byName.get('browser_extract').parameters.selector.required, true)
  assert.equal(byName.get('browser_click_index').parameters.index.required, true)
  assert.equal(byName.get('browser_zoom').parameters.factor.required, true)
})
