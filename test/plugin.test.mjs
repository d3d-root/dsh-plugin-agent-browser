// Проверка, что плагин собирается и регистрирует инструменты.
//
// apply() запускается на поддельном контексте Cordis: настоящий требует
// сервисов DSH, которых в тесте нет. Проверяем то, что чаще всего ломается при
// правках: список инструментов, их параметры и то, что ни один не бросает
// исключение при сборке.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Настройки для тестов: свой журнал во временной папке.
 *
 * Без этого apply() пишет в общий журнал плагина, и тесты засоряют
 * диагностику настоящей установки — в нём появляются чужие строки «apply() начат».
 */
const TEST_CONFIG = { debug: false, logFile: join(tmpdir(), 'dsh-agent-browser-test.log') }

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

/** Собрать инструменты плагина на поддельном контексте. */
async function collectTools() {
  const { apply } = await import('../lib/index.js')
  const ctx = fakeContext()
  apply(ctx, TEST_CONFIG)
  return ctx.registered
}

test('apply регистрирует инструменты и не падает', async () => {
  const tools = await collectTools()
  assert.ok(tools.length >= 35, `инструментов ${tools.length}, ожидалось не меньше 35`)
})

test('у каждого инструмента есть имя, описание и обработчик', async () => {
  for (const tool of await collectTools()) {
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
  const names = (await collectTools()).map((tool) => tool.name)
  assert.equal(new Set(names).size, names.length, 'есть повторяющиеся имена')
})

test('все инструменты принимают tabId — адресация вкладки', async () => {
  for (const tool of await collectTools()) {
    assert.ok(tool.parameters.tabId, `у ${tool.name} нет tabId`)
    assert.equal(tool.parameters.tabId.type, 'string')
  }
})

test('инструменты 1.1.0 на месте', async () => {
  const names = new Set((await collectTools()).map((tool) => tool.name))
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
  const byName = new Map((await collectTools()).map((tool) => [tool.name, tool]))
  assert.equal(byName.get('browser_upload').parameters.files.required, true)
  assert.equal(byName.get('browser_download').parameters.url.required, true)
  assert.equal(byName.get('browser_extract').parameters.selector.required, true)
  assert.equal(byName.get('browser_click_index').parameters.index.required, true)
  assert.equal(byName.get('browser_zoom').parameters.factor.required, true)
})

test('описания инструментов на английском — их читает модель', async () => {
  for (const tool of await collectTools()) {
    assert.match(tool.description, /[A-Za-z]/, `описание ${tool.name} без латиницы`)
    // Кириллица в описании инструмента означает, что строка осталась из
    // русской версии: модель её поймёт, но англоязычный пользователь — нет.
    assert.doesNotMatch(tool.description, /[А-Яа-яЁё]/, `описание ${tool.name} не переведено`)
  }
})
