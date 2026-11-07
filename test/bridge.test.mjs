// Юнит-тесты моста: маршрутизация команд по сессиям, длинный опрос,
// управляющие команды и обработка ошибок. Сеть не нужна — мост вызывается
// напрямую через handle().
//
// Запуск: node --test test/

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createBridge, PROTOCOL_VERSION, startLoopbackTransport } from '../lib/bridge.mjs'

/** Создать мост с панелью, зарегистрированной в сессии. */
async function bridgeWithPanel(sessionId, panelId, extra = {}) {
  const bridge = createBridge()
  const hello = await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
    panelId,
    sessionId,
    tabId: extra.tabId || 'tab-' + panelId,
    visible: extra.visible ?? true,
  })
  assert.equal(hello.status, 200)
  return bridge
}

/** Забрать одну команду, отправленную панели, и ответить на неё. */
async function serveOne(bridge, panelId, reply) {
  const poll = bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: panelId }), {})
  // Дать команде дойти до очереди панели.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await poll).body
  assert.ok(command && command.id !== undefined, 'панель должна получить команду')
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), {
    id: command.id,
    ok: true,
    result: reply(command),
  })
  return command
}

test('health сообщает версию протокола', async () => {
  const bridge = createBridge()
  const { body } = await bridge.handle('GET', '/health', new URLSearchParams(), {})
  assert.equal(body.ok, true)
  assert.equal(body.version, PROTOCOL_VERSION)
  assert.equal(body.panels, 0)
})

test('панель регистрируется и видна в состоянии', async () => {
  const bridge = await bridgeWithPanel('s1', 'p1')
  const { body } = await bridge.handle('GET', '/state', new URLSearchParams(), {})
  assert.equal(body.panels.length, 1)
  assert.equal(body.panels[0].sessionId, 's1')
  assert.equal(body.panels[0].tabId, 'tab-p1')
})

test('команда уходит панели той сессии, чей агент её вызвал', async () => {
  const bridge = createBridge()
  await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
    panelId: 'p-a',
    sessionId: 'session-a',
    tabId: 'tab-a',
    visible: true,
  })
  await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
    panelId: 'p-b',
    sessionId: 'session-b',
    tabId: 'tab-b',
    visible: true,
  })

  const pending = bridge.handle('POST', '/cmd', new URLSearchParams(), {
    sessionId: 'session-b',
    type: 'url',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  // Панель сессии A не должна получить чужую команду.
  assert.equal(bridge.isQueued('p-a'), false, 'панели другой сессии команда не положена')

  const forB = await bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'p-b' }), {})
  assert.equal(forB.body.type, 'url')
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), {
    id: forB.body.id,
    ok: true,
    result: { url: 'https://example.com', title: 'Example' },
  })

  const answer = await pending
  assert.equal(answer.body.ok, true)
  assert.equal(answer.body.result.url, 'https://example.com')
  assert.equal(answer.body.result.panel, 'p-b')
})

test('без панели в сессии команда возвращает код no-panel, а не молчит', async () => {
  const bridge = createBridge()
  const { body } = await bridge.handle('POST', '/cmd', new URLSearchParams(), {
    sessionId: 'пустая',
    type: 'url',
  })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'no-panel')
  assert.match(body.error, /browser_open/)
})

test('две панели одной сессии: видимая выбирается первой', async () => {
  const bridge = createBridge()
  for (const [panelId, visible] of [
    ['p-hidden', false],
    ['p-visible', true],
  ]) {
    await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
      panelId,
      sessionId: 's1',
      tabId: panelId,
      visible,
    })
  }
  const pending = bridge.handle('POST', '/cmd', new URLSearchParams(), { sessionId: 's1', type: 'url' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'p-visible' }), {})).body
  assert.equal(command.type, 'url')
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), { id: command.id, ok: true, result: {} })
  assert.equal((await pending).body.result.panel, 'p-visible')
})

test('точный id панели перебивает выбор по сессии', async () => {
  const bridge = createBridge()
  for (const panelId of ['p1', 'p2']) {
    await bridge.handle('POST', '/panel/hello', new URLSearchParams(), {
      panelId,
      sessionId: 's1',
      tabId: panelId,
      visible: panelId === 'p1',
    })
  }
  const pending = bridge.handle('POST', '/cmd', new URLSearchParams(), {
    sessionId: 's1',
    panel: 'p2',
    type: 'url',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'p2' }), {})).body
  assert.equal(command.type, 'url')
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), { id: command.id, ok: true, result: {} })
  assert.equal((await pending).body.result.panel, 'p2')
})

test('ошибка панели превращается в отказ команды с текстом', async () => {
  const bridge = await bridgeWithPanel('s1', 'p1')
  const pending = bridge.handle('POST', '/cmd', new URLSearchParams(), { sessionId: 's1', type: 'eval' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'p1' }), {})).body
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), {
    id: command.id,
    ok: false,
    result: { error: 'страница не загружена' },
  })
  const { body } = await pending
  assert.equal(body.ok, false)
  assert.equal(body.code, 'panel-error')
  assert.equal(body.error, 'страница не загружена')
})

test('bye убирает панель из состояния', async () => {
  const bridge = await bridgeWithPanel('s1', 'p1')
  await bridge.handle('POST', '/panel/bye', new URLSearchParams(), { panelId: 'p1' })
  const { body } = await bridge.handle('GET', '/state', new URLSearchParams(), {})
  assert.equal(body.panels.length, 0)
})

test('управляющая команда доходит до страницы DSH и возвращает результат', async () => {
  const bridge = createBridge()
  const hello = await bridge.handle('POST', '/client/hello', new URLSearchParams(), {})
  const clientId = hello.body.clientId
  assert.ok(clientId)

  const pending = bridge.handle('POST', '/control', new URLSearchParams(), {
    type: 'open',
    sessionId: 's1',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await bridge.handle('GET', '/client/poll', new URLSearchParams({ client: clientId }), {})).body
  assert.equal(command.type, 'open')
  assert.equal(command.sessionId, 's1')
  await bridge.handle('POST', '/client/reply', new URLSearchParams(), {
    id: command.id,
    ok: true,
    result: { opened: true },
  })
  const { body } = await pending
  assert.equal(body.ok, true)
  assert.equal(body.result.opened, true)
})

test('без страницы DSH управляющая команда возвращает no-client', async () => {
  const bridge = createBridge()
  const { body } = await bridge.handle('POST', '/control', new URLSearchParams(), { type: 'open' })
  assert.equal(body.ok, false)
  assert.equal(body.code, 'no-client')
})

test('длинный опрос панели ждёт команду и получает её', async () => {
  const bridge = await bridgeWithPanel('s1', 'p1')
  const poll = bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'p1' }), {})
  await new Promise((resolve) => setTimeout(resolve, 30))
  const sending = bridge.handle('POST', '/cmd', new URLSearchParams(), { sessionId: 's1', type: 'url' })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const command = (await poll).body
  assert.equal(command.type, 'url')
  await bridge.handle('POST', '/panel/reply', new URLSearchParams(), { id: command.id, ok: true, result: { url: 'u' } })
  assert.equal((await sending).body.result.url, 'u')
})

test('опрос неизвестной панели не подвешивает запрос', async () => {
  const bridge = createBridge()
  const started = Date.now()
  const { body } = await bridge.handle('GET', '/panel/poll', new URLSearchParams({ panel: 'нет' }), {})
  assert.deepEqual(body, {})
  assert.ok(Date.now() - started < 1000)
})

test('loopback-транспорт отдаёт health по своему базовому пути', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 'test-token' })
  try {
    const ok = await fetch(`${transport.base}/health`, {
      headers: { 'x-agent-browser-token': 'test-token' },
    })
    assert.equal(ok.status, 200)
    assert.equal((await ok.json()).version, PROTOCOL_VERSION)

    const denied = await fetch(`${transport.base}/health`)
    assert.equal(denied.status, 403)

    const outside = await fetch(`http://127.0.0.1:${transport.port}/other-path`)
    assert.equal(outside.status, 404)
  } finally {
    await transport.close()
  }
})

test('loopback-транспорт отдаёт токен через /bootstrap без заголовка', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 'boot-token' })
  try {
    // Клиент может не получить настройки из index.html (страница отдана
    // раньше, чем плагин зарегистрировал вставку) — тогда он берёт токен здесь.
    const response = await fetch(`${transport.base}/bootstrap`)
    assert.equal(response.status, 200)
    const data = await response.json()
    assert.equal(data.ok, true)
    assert.equal(data.token, 'boot-token')
    assert.equal(data.version, PROTOCOL_VERSION)

    // С этим токеном обычные запросы проходят.
    const state = await fetch(`${transport.base}/state`, {
      headers: { 'x-agent-browser-token': data.token },
    })
    assert.equal(state.status, 200)
  } finally {
    await transport.close()
  }
})

test('/bootstrap разрешает читать ответ только origin `null`, а не любому сайту', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 't' })
  try {
    const response = await fetch(`${transport.base}/bootstrap`, {
      headers: { origin: 'https://evil.example' },
    })
    // Звёздочки быть не должно: иначе токен прочитает любой сайт.
    assert.equal(response.headers.get('access-control-allow-origin'), 'null')
    assert.notEqual(response.headers.get('access-control-allow-origin'), '*')
  } finally {
    await transport.close()
  }
})

test('/bootstrap не отдаёт токен межсайтовому запросу', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 't' })
  try {
    // Браузер сам ставит Sec-Fetch-Site; подделывать его fetch не даёт, поэтому http.
    const withSite = (site) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: '127.0.0.1',
            port: transport.port,
            path: '/dsh-agent-browser/bootstrap',
            headers: { 'sec-fetch-site': site },
          },
          (response) => {
            response.resume()
            response.on('end', () => resolve(response.statusCode))
          },
        )
        request.on('error', reject)
        request.end()
      })

    // Страница чужого сайта в браузере помечается `cross-site`.
    assert.equal(await withSite('cross-site'), 403)
    // Своя страница — `same-origin` (или `none` для прямого ввода адреса).
    assert.equal(await withSite('same-origin'), 200)
    assert.equal(await withSite('none'), 200)
  } finally {
    await transport.close()
  }
})

test('/bootstrap отвергает чужой Host (защита от DNS-rebinding)', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 't' })
  /** Запрос с подменённым Host: fetch такое заголовок запрещает, поэтому http напрямую. */
  const withHost = (host) =>
    new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port: transport.port, path: `${'/dsh-agent-browser'}/bootstrap`, headers: { host } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode))
        },
      )
      request.on('error', reject)
      request.end()
    })

  try {
    // Браузер при rebinding присылает Host чужого домена, хотя соединение идёт
    // на 127.0.0.1. Токен в таком случае отдавать нельзя.
    assert.equal(await withHost('evil.example'), 403)
    assert.equal(await withHost(`127.0.0.1:${transport.port}`), 200)
  } finally {
    await transport.close()
  }
})

test('loopback-транспорт не пускает без токена и не отдаёт токен в ответе', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 'secret-1' })
  try {
    const noToken = await fetch(`${transport.base}/state`)
    assert.equal(noToken.status, 403)

    const wrong = await fetch(`${transport.base}/state`, { headers: { 'x-agent-browser-token': 'other' } })
    assert.equal(wrong.status, 403)

    // Токен не должен приезжать в теле ответа или в заголовках.
    const ok = await fetch(`${transport.base}/health`, { headers: { 'x-agent-browser-token': 'secret-1' } })
    const text = await ok.text()
    assert.ok(!text.includes('secret-1'), 'токен не должен попадать в тело ответа')
  } finally {
    await transport.close()
  }
})

test('loopback-транспорт отвечает на предварительный запрос CORS', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 't' })
  try {
    const preflight = await fetch(`${transport.base}/cmd`, {
      method: 'OPTIONS',
      headers: {
        origin: 'null',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-agent-browser-token',
      },
    })
    assert.equal(preflight.status, 204)
    // origin `null` разрешён, произвольный сайт — нет (звёздочки быть не должно).
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'null')
  } finally {
    await transport.close()
  }
})

test('слишком большое тело запроса отвергается, а не съедает память', async () => {
  const bridge = createBridge()
  const transport = await startLoopbackTransport(bridge, { port: 0, token: 't' })
  try {
    const huge = JSON.stringify({ type: 'eval', code: 'x'.repeat(9 * 1024 * 1024) })
    const response = await fetch(`${transport.base}/cmd`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-browser-token': 't' },
      body: huge,
    })
    assert.equal(response.status, 413)
  } finally {
    await transport.close()
  }
})

test('команда без панели не оставляет висящих ожиданий', async () => {
  const bridge = createBridge()
  const before = bridge.inflightCount
  const { body } = await bridge.handle('POST', '/cmd', new URLSearchParams(), { sessionId: 'нет', type: 'url' })
  assert.equal(body.code, 'no-panel')
  assert.equal(bridge.inflightCount, before)
})

test('управляющая команда отвечает not-mine, когда сессии нет ни в одном окне', async () => {
  const bridge = createBridge()
  const hello = await bridge.handle('POST', '/client/hello', new URLSearchParams(), {})
  const clientId = hello.body.clientId
  const pending = bridge.handle('POST', '/control', new URLSearchParams(), { type: 'open', sessionId: 's1' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const command = (await bridge.handle('GET', '/client/poll', new URLSearchParams({ client: clientId }), {})).body
  await bridge.handle('POST', '/client/reply', new URLSearchParams(), {
    id: command.id,
    ok: false,
    result: { code: 'not-mine' },
  })
  const { body } = await pending
  assert.equal(body.ok, false)
  assert.equal(body.code, 'not-mine')
})

test('одно окно отвечает not-mine, а второе берёт команду — побеждает второе', async () => {
  const bridge = createBridge()
  const first = (await bridge.handle('POST', '/client/hello', new URLSearchParams(), {})).body.clientId
  const second = (await bridge.handle('POST', '/client/hello', new URLSearchParams(), {})).body.clientId
  assert.notEqual(first, second)

  const pending = bridge.handle('POST', '/control', new URLSearchParams(), { type: 'open', sessionId: 's1' })
  await new Promise((resolve) => setTimeout(resolve, 30))

  const forFirst = (await bridge.handle('GET', '/client/poll', new URLSearchParams({ client: first }), {})).body
  const forSecond = (await bridge.handle('GET', '/client/poll', new URLSearchParams({ client: second }), {})).body
  assert.equal(forFirst.id, forSecond.id, 'обе страницы получают одну и ту же команду')

  await bridge.handle('POST', '/client/reply', new URLSearchParams(), {
    id: forFirst.id,
    ok: false,
    result: { code: 'not-mine' },
  })
  await bridge.handle('POST', '/client/reply', new URLSearchParams(), {
    id: forSecond.id,
    ok: true,
    result: { opened: true },
  })

  const { body } = await pending
  assert.equal(body.ok, true)
  assert.equal(body.result.opened, true)
})
