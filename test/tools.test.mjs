// Инструменты целиком: настоящий мост, настоящий транспорт, поддельная панель.
//
// Зачем это отдельно от bridge.test.mjs: тот проверяет маршрутизацию, а здесь
// проверяется то, что видит модель, — текст ответа инструмента. Именно на этом
// слое жили ошибки, которые не видны ни тестам моста, ни типам: хост читал
// `result.found`, а клиент кладёт `{ value: { found } }`, и инструмент всегда
// отвечал «не появилось».
//
// Панель здесь — не заглушка ради заглушки: она отвечает ровно тем же
// конвертом, что и настоящий клиент (`{ ok, result }`), поэтому расхождение
// формы ответа снова упадёт этим тестом.

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBridge, startLoopbackTransport } from '../lib/bridge.mjs'

const SESSION = 'session-tools-test'
const PANEL = 'panel-tools-test'
const TOKEN = 'tools-test-token'

// Рабочий каталог «чата»: инструменты пишут файлы только внутрь него, поэтому
// тест создаёт свой временный каталог и не мусорит в репозитории.
const WORKSPACE = mkdtempSync(join(tmpdir(), 'dsh-agent-browser-ws-'))
process.on('exit', () => {
  try {
    rmSync(WORKSPACE, { recursive: true, force: true })
  } catch {
    /* каталог мог остаться занятым */
  }
})

/**
 * Поднять плагин поверх настоящего моста и поддельной панели.
 *
 * @param answers - что панель отвечает на команду: тип → `result` команды.
 * @returns `{ tools, call, stop }`.
 */
async function rig(answers, options = {}) {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { token: TOKEN, basePath: '/dsh-agent-browser' })

  await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
    panelId: PANEL,
    sessionId: SESSION,
    tabId: 'tab-1',
    visible: true,
  })

  // Панель отвечает в фоне: так же, как настоящая, длинным опросом.
  let running = true
  const headers = { 'content-type': 'application/json', 'x-agent-browser-token': TOKEN }
  const loop = (async () => {
    while (running) {
      let command
      try {
        const response = await fetch(`${transport.base}/panel/poll?panel=${PANEL}`, { headers })
        command = await response.json()
      } catch {
        return
      }
      if (!command || command.id === undefined) continue
      const handler = answers[command.type]
      const result = handler === undefined ? { error: `нет ответа для ${command.type}` } : handler(command)
      try {
        await fetch(`${transport.base}/panel/reply`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ id: command.id, ok: handler !== undefined, result }),
        })
      } catch {
        return
      }
    }
  })()

  // Мост и состояние переживают горячую перезагрузку через globalThis —
  // подставляем готовые, чтобы плагин не поднимал второй транспорт.
  globalThis.__dshAgentBrowserBridge = bridge
  globalThis.__dshAgentBrowserState = {
    base: transport.base,
    hostBase: transport.base,
    token: TOKEN,
    dispose: null,
    inject: null,
  }

  const registered = []
  const { apply } = await import('../lib/index.js')
  apply(
    {
      tools: { register: (tool) => registered.push(tool) },
      reflect: { get: () => undefined },
      effect: (fn) => {
        try {
          return fn()
        } catch {
          return () => {}
        }
      },
      on() {},
      logger: { info() {}, warn() {}, error() {} },
    },
    {
      debug: false,
      logFile: join(tmpdir(), 'dsh-agent-browser-tools-test.log'),
      // Язык задаём явно. Часть ответов приходит из словаря MESSAGES
      // («Скриншот сохранён», «видимая область»), а по умолчанию язык
      // выбирается по локали машины: на CI она en-US, и проверки русских
      // строк падали бы при том же коде. Тесты не должны зависеть от
      // окружения — иначе зелёный прогон локально ничего не значит.
      language: options.language || 'ru',
    },
  )

  const call = async (name, args = {}) => {
    const tool = registered.find((entry) => entry.name === name)
    assert.ok(tool, `нет инструмента ${name}`)
    // Рабочий каталог задаём явно: инструменты пишут файлы только в него,
    // а тест не должен мусорить в каталоге репозитория.
    return (tool.execute || tool.run)(args, {
      agent: { id: SESSION, session: { header: { cwd: WORKSPACE } } },
    })
  }

  return {
    tools: registered,
    call,
    async stop() {
      running = false
      await transport.close()
      delete globalThis.__dshAgentBrowserBridge
      delete globalThis.__dshAgentBrowserState
    },
  }
}

test('browser_wait сообщает, что текст дождались — а не «не появилось»', async (t) => {
  const r = await rig({ wait: () => ({ value: { found: true, waitedMs: 120 } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_wait', { text: 'Купить', ms: 500 })
  assert.match(out, /Дождались за 120 мс/)
  assert.match(out, /текст «Купить»/)
})

test('browser_wait честно говорит, что не дождались', async (t) => {
  const r = await rig({ wait: () => ({ value: { found: false, waitedMs: 500 } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_wait', { selector: '.nope', ms: 500 })
  assert.match(out, /Не появилось за 500 мс/)
  assert.match(out, /селектор \.nope/)
})

test('browser_find_in_page показывает число совпадений', async (t) => {
  const r = await rig({ findInPage: () => ({ value: { ok: true, text: 'дом', matches: 3, active: 1 } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_find_in_page', { text: 'дом' })
  assert.match(out, /совпадений 3, активно 1/)
})

test('browser_find_in_page отличает «не найдено» от ошибки', async (t) => {
  const r = await rig({ findInPage: () => ({ value: { ok: true, text: 'нет', matches: 0, active: 0 } }) })
  t.after(() => r.stop())
  assert.match(await r.call('browser_find_in_page', { text: 'нет' }), /«нет» не найдено/)
})

test('browser_scroll показывает позицию', async (t) => {
  // Клиент отдаёт JSON-строку в `value` — как и настоящий (lib/client.js).
  const r = await rig({ scroll: () => ({ value: JSON.stringify({ y: 200, h: 1000, vh: 700 }) }) })
  t.after(() => r.stop())
  const out = await r.call('browser_scroll', { deltaY: 200 })
  assert.match(out, /Прокручено на 200/)
  assert.match(out, /Позиция 200 из 300/)
})

test('browser_read отдаёт адрес, заголовок и текст', async (t) => {
  const r = await rig({
    url: () => ({ url: 'https://example.com/', title: 'Example' }),
    text: () => ({ text: 'видимый текст' }),
  })
  t.after(() => r.stop())
  const out = await r.call('browser_read')
  assert.match(out, /https:\/\/example\.com\//)
  assert.match(out, /Example/)
  assert.match(out, /видимый текст/)
})

test('browser_back и browser_forward показывают адрес', async (t) => {
  const r = await rig({
    back: () => ({ url: 'https://example.com/back' }),
    forward: () => ({ url: 'https://example.com/fwd' }),
  })
  t.after(() => r.stop())
  assert.match(await r.call('browser_back'), /example\.com\/back/)
  assert.match(await r.call('browser_forward'), /example\.com\/fwd/)
})

test('browser_extract печатает массив объектов', async (t) => {
  const r = await rig({
    extract: () => ({
      value: JSON.stringify({ ok: true, total: 2, count: 1, items: [{ title: 'Карточка', price: '100' }] }),
    }),
  })
  t.after(() => r.stop())
  const out = await r.call('browser_extract', { selector: '.card', fields: { title: '', price: '' } })
  assert.match(out, /Извлечено 1 из 2/)
  assert.match(out, /Карточка/)
})

test('browser_extract объясняет пустой результат', async (t) => {
  const r = await rig({
    extract: () => ({ value: JSON.stringify({ ok: true, total: 0, count: 0, items: [] }) }),
  })
  t.after(() => r.stop())
  const out = await r.call('browser_extract', { selector: '.none', fields: { title: '' } })
  assert.match(out, /Ничего не найдено по селектору \.none/)
})

test('browser_drag отчитывается координатами', async (t) => {
  const r = await rig({ drag: () => ({ ok: true, from: [10, 20], to: [300, 20], steps: 28 }) })
  t.after(() => r.stop())
  const out = await r.call('browser_drag', { fromX: 10, fromY: 20, toX: 300, toY: 20 })
  assert.match(out, /из \(10, 20\) в \(300, 20\)/)
})

test('browser_screenshot в фоне просит показать вкладку, а не висит', async (t) => {
  const r = await rig({ screenshot: () => ({ value: { ok: false, hidden: true } }) })
  t.after(() => r.stop())
  await assert.rejects(
    () => r.call('browser_screenshot', {}),
    (error) => {
      assert.match(String(error.message), /browser_reveal/)
      return true
    },
  )
})

test('ошибка панели превращается в понятный текст', async (t) => {
  const r = await rig({})
  t.after(() => r.stop())
  await assert.rejects(
    () => r.call('browser_page_state'),
    (error) => {
      assert.match(String(error.message), /нет ответа для pageState/)
      return true
    },
  )
})

test('browser_tabs показывает id вкладки — иначе tabId не на что указывать', async (t) => {
  const r = await rig({})
  t.after(() => r.stop())
  const out = await r.call('browser_tabs')
  assert.match(out, /Вкладок: 1/)
  assert.match(out, /\[tab-1\]/, `ответ: ${out}`)
})

test('browser_download берёт файл у страницы, когда та может его прочитать', async (t) => {
  const payload = Buffer.from('содержимое файла', 'utf8').toString('base64')
  const r = await rig({ download: () => ({ value: { ok: true, base64: payload, mime: 'text/plain' } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_download', { url: 'https://example.com/file.txt' })
  assert.match(out, /Скачано:/)
  assert.doesNotMatch(out, /Источник: хост/, 'хостовый путь не должен включаться без нужды')
  const written = readFileSync(join(WORKSPACE, 'file.txt'), 'utf8')
  assert.equal(written, 'содержимое файла')
})

test('browser_download не ходит хостовым путём на локальные адреса', async (t) => {
  // Страница «не смогла» — значит включился бы запасной путь через хост.
  // На localhost он запрещён: иначе агент обошёл бы запрет webview ходить
  // на служебные адреса и вытащил бы ответ локального сервиса файлом.
  const r = await rig({ download: () => ({ value: { ok: false, reason: 'сеть или CORS' } }) })
  t.after(() => r.stop())
  for (const url of [
    'http://127.0.0.1:9/secret',
    'http://localhost:9/secret',
    'http://192.168.1.1/secret',
    'http://10.0.0.5/secret',
    'http://169.254.169.254/latest/meta-data',
  ]) {
    const out = await r.call('browser_download', { url })
    assert.match(out, /Скачать не удалось/, `адрес ${url}: ${out}`)
    assert.match(out, /локальные адреса/, `адрес ${url}: ${out}`)
  }
})

test('browser_download отказывает не-http схеме на хостовом пути', async (t) => {
  const r = await rig({ download: () => ({ value: { ok: false, reason: 'сеть или CORS' } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_download', { url: 'file:///C:/Windows/win.ini' })
  assert.match(out, /Скачать не удалось/)
  assert.match(out, /http и https/)
})

test('browser_screenshot повторяет съёмку, если вкладка только что вышла на экран', async (t) => {
  // Первые два вызова — «не отрисована», третий отдаёт картинку: так ведёт
  // себя Chromium сразу после browser_reveal.
  let attempt = 0
  const png = Buffer.from('fake-png-bytes').toString('base64')
  const r = await rig({
    screenshot: () => {
      attempt += 1
      return attempt <= 2 ? { value: { ok: false, hidden: true } } : { dataUrl: `data:image/png;base64,${png}` }
    },
  })
  t.after(() => r.stop())
  const out = await r.call('browser_screenshot', { path: 'retry.png' })
  assert.match(out, /Скриншот сохранён/)
  assert.equal(attempt, 3, 'должно быть три попытки: две неудачные и одна успешная')
})

test('browser_screenshot сдаётся и просит reveal, если вкладка так и не отрисовалась', async (t) => {
  const r = await rig({ screenshot: () => ({ value: { ok: false, hidden: true } }) })
  t.after(() => r.stop())
  await assert.rejects(
    () => r.call('browser_screenshot', {}),
    (error) => {
      assert.match(String(error.message), /browser_reveal/)
      return true
    },
  )
})

test('browser_download идёт хостовым путём, если страница вернула пустой файл', async (t) => {
  // Страница «успешно» скачала ноль байт — раньше это записалось бы пустым
  // файлом. Теперь включается хостовый путь; адрес локальный, поэтому он
  // отказывает сразу и без сети — по отказу видно, что запасной путь включился.
  const r = await rig({ download: () => ({ value: { ok: true, base64: '', mime: 'image/jpeg' } }) })
  t.after(() => r.stop())
  const out = await r.call('browser_download', { url: 'http://127.0.0.1:9/empty.bin' })
  assert.match(out, /Скачать не удалось/)
  assert.match(out, /локальные адреса/)
})

test('язык ответов берётся из настройки, а не из локали машины', async (t) => {
  // На CI локаль en-US, локально ru-RU. Если ответы приходят из словаря
  // MESSAGES, тест обязан зафиксировать язык настройкой — иначе он зелёный
  // на одной машине и красный на другой при том же коде (ровно так упал
  // прогон 2.1.1 в GitHub Actions).
  const png = Buffer.from('fake-png').toString('base64')
  const r = await rig({ screenshot: () => ({ dataUrl: `data:image/png;base64,${png}` }) }, { language: 'en' })
  t.after(() => r.stop())
  const out = await r.call('browser_screenshot', { path: 'en.png' })
  assert.match(out, /Screenshot saved/, `ответ на английском: ${out}`)
  assert.doesNotMatch(out, /Скриншот сохранён/, 'русская строка не должна просачиваться в en-режим')
})
