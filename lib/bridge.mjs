/**
 * Мост между агентом и браузерами в правой панели.
 *
 * Здесь только состояние и маршрутизация — ни сокетов, ни HTTP. Транспорт
 * (маршрут на встроенном веб-сервере DSH или собственный loopback-сервер)
 * вызывает `handle()` и отдаёт ответ как есть. Такое разделение позволяет
 * проверять всю логику маршрутизации юнит-тестами без сети.
 *
 * Модель:
 *   панель  — смонтированный <webview> в правой панели одной сессии;
 *   клиент  — страница DSH, на которой работает сторож открытия.
 *
 * Команда агента всегда адресуется сессии: панель выбирается среди панелей
 * этой сессии, поэтому два агента в разных сессиях не мешают друг другу.
 */

import { randomUUID } from 'node:crypto'

/** Версия протокола. Клиент и хост сверяют её при подключении. */
export const PROTOCOL_VERSION = 2

/** Сколько панель может молчать, прежде чем мы сочтём её исчезнувшей. */
const PANEL_TTL_MS = 45_000
/** Сколько держим длинный опрос панели открытым. */
const POLL_TIMEOUT_MS = 25_000
/** Сколько ждём ответа панели на команду. */
const COMMAND_TIMEOUT_MS = 30_000
/** Сколько ждём, пока клиент выполнит управляющую команду. */
const CONTROL_TIMEOUT_MS = 20_000
/** Предел журнала в памяти. */
const LOG_LIMIT = 400
/** Предел тела запроса: команды и ответы — короткий JSON. */
export const MAX_BODY_BYTES = 8 * 1024 * 1024

/** Ошибка с машинным кодом — чтобы инструменты могли подсказать, что делать. */
export class BridgeError extends Error {
  /**
   * @param code - машинный код (`no-panel`, `timeout`, `no-client`, …).
   * @param message - текст для человека.
   * @param extra - дополнительные поля ответа.
   */
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.extra = extra
  }
}

/** Очередь ожидающих: каждый элемент — либо готовый к отправке, либо ждущий получатель. */
function createInbox() {
  return { queue: [], waiter: null }
}

/** Отдать элемент получателю или поставить в очередь. */
function deliver(inbox, item) {
  if (inbox.waiter) {
    const { resolve, timer } = inbox.waiter
    inbox.waiter = null
    clearTimeout(timer)
    resolve(item)
    return
  }
  inbox.queue.push(item)
}

/** Забрать элемент или подождать до таймаута. */
function take(inbox, timeoutMs) {
  if (inbox.queue.length > 0) return Promise.resolve(inbox.queue.shift())
  if (inbox.waiter) return inbox.waiter.promise
  let timer = null
  const promise = new Promise((resolve) => {
    inbox.waiter = { resolve, timer: null, promise: null }
    timer = setTimeout(() => {
      if (inbox.waiter && inbox.waiter.promise === promise) inbox.waiter = null
      resolve(undefined)
    }, timeoutMs)
    inbox.waiter.timer = timer
  })
  inbox.waiter.promise = promise
  return promise
}

/** Есть ли в очереди что-то для получателя. */
function hasQueued(inbox) {
  return inbox.queue.length > 0
}

/**
 * Создать мост.
 * @param options - `startUrl` (стартовая страница новой панели).
 * @returns мост с `handle()` для транспорта и служебными методами.
 */
export function createBridge(options = {}) {
  let startUrl = typeof options.startUrl === 'string' && options.startUrl ? options.startUrl : 'about:blank'
  /** panelId → сведения о панели. */
  const panels = new Map()
  /** clientId → входящие управляющие команды для страницы. */
  const clients = new Map()
  /** cmdId → ожидающий ответа агент. */
  const inflight = new Map()
  /** clientId → ожидающие ответа управляющие команды. */
  const controlInflight = new Map()

  const log = []
  let seq = 1

  /** Записать событие в кольцевой журнал. */
  function note(level, message) {
    log.push({ at: new Date().toISOString(), level, message: String(message) })
    if (log.length > LOG_LIMIT) log.shift()
  }

  /** Убрать панели и клиентов, которые давно не выходили на связь. */
  function sweep() {
    const now = Date.now()
    for (const [id, panel] of panels) {
      if (now - panel.lastSeen > PANEL_TTL_MS) {
        panels.delete(id)
        note('info', `панель исчезла: ${id}`)
      }
    }
    for (const [id, client] of clients) {
      if (now - client.lastSeen > PANEL_TTL_MS * 2) clients.delete(id)
    }
  }

  /** Панель по её идентификатору. */
  function panelById(panelId) {
    const panel = panels.get(panelId)
    if (!panel) return undefined
    panel.lastSeen = Date.now()
    return panel
  }

  /** Панели одной сессии, самые подходящие первыми. */
  function panelsOf(sessionId) {
    const found = []
    for (const panel of panels.values()) {
      if (sessionId === undefined || panel.sessionId === sessionId) found.push(panel)
    }
    found.sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1
      return b.lastSeen - a.lastSeen
    })
    return found
  }

  /**
   * Выбрать панель-получателя.
   * @param sessionId - сессия агента; `undefined` — любая видимая.
   * @param hints - `panel` (точный id) или `tab` (id вкладки в доке).
   */
  function pickPanel(sessionId, hints = {}) {
    if (hints.panel) {
      const exact = panelById(hints.panel)
      if (exact) return exact
      throw new BridgeError('no-panel', `панель ${hints.panel} не найдена или уже закрыта`)
    }
    const candidates = panelsOf(sessionId)
    if (hints.tab) {
      const byTab = candidates.find((panel) => panel.tabId === hints.tab)
      if (byTab) return byTab
      throw new BridgeError('no-panel', `вкладка ${hints.tab} не найдена в этой сессии`)
    }
    if (candidates.length > 0) return candidates[0]
    throw new BridgeError(
      'no-panel',
      sessionId === undefined
        ? 'ни одна вкладка «Браузер агента» не открыта — вызовите browser_open'
        : 'в этой сессии браузер не открыт — вызовите browser_open',
      { sessionId: sessionId ?? null },
    )
  }

  /** Отправить команду панели и дождаться результата. */
  function sendToPanel(panel, command) {
    const id = `c${seq++}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        inflight.delete(id)
        reject(new BridgeError('timeout', `браузер не ответил за ${COMMAND_TIMEOUT_MS / 1000} с`))
      }, COMMAND_TIMEOUT_MS)
      inflight.set(id, { resolve, reject, timer, panelId: panel.id })
      deliver(panel.inbox, { ...command, id })
    })
  }

  /**
   * Отправить управляющую команду страницам DSH и дождаться результата.
   *
   * Команда уходит всем подключённым страницам сразу: какая сессия на экране,
   * знает только клиент, поэтому отвечает та страница, у которой эта сессия
   * есть. Остальные отвечают `not-mine`, и это не ошибка. Так один мост
   * обслуживает несколько окон DSH.
   * @param command - команда (`open`, `reveal`, `close`, `focus`).
   */
  function sendToClient(command) {
    const targets = [...clients.values()]
    if (targets.length === 0) {
      throw new BridgeError(
        'no-client',
        'клиентская половина плагина не загружена в окне. Нажмите Ctrl+R (перезагрузка окна); ' +
          'если не помогло — перезапустите DeepSeek Harness',
      )
    }
    const id = `k${seq++}`
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, remaining: targets.length, timer: null }
      entry.timer = setTimeout(() => {
        controlInflight.delete(id)
        reject(new BridgeError('timeout', 'страница DSH не ответила на команду'))
      }, CONTROL_TIMEOUT_MS)
      controlInflight.set(id, entry)
      for (const target of targets) deliver(target.inbox, { ...command, id })
    })
  }

  /**
   * Обработать запрос транспорта.
   * @param method - HTTP-метод.
   * @param pathname - путь без базового префикса (`/health`, `/cmd`, …).
   * @param query - параметры строки запроса.
   * @param body - разобранное тело запроса.
   * @returns `{ status, body }`.
   */
  async function handle(method, pathname, query, body) {
    sweep()

    if (pathname === '/health') {
      return {
        status: 200,
        body: {
          ok: true,
          version: PROTOCOL_VERSION,
          panels: panels.size,
          clients: clients.size,
          sessions: [...new Set([...panels.values()].map((panel) => panel.sessionId))],
        },
      }
    }

    // Стартовая страница новой панели: её просит клиент при создании webview.
    if (pathname === '/start') {
      return { status: 200, body: { url: startUrl } }
    }

    // --- сторона панели (браузера) ---

    if (pathname === '/panel/hello' && method === 'POST') {
      const { panelId, sessionId, tabId, visible } = body || {}
      if (!panelId || !sessionId) {
        return { status: 400, body: { ok: false, error: 'panelId и sessionId обязательны' } }
      }
      const known = panels.get(panelId)
      if (known) {
        known.sessionId = sessionId
        known.tabId = tabId || known.tabId
        known.visible = visible === undefined ? known.visible : Boolean(visible)
        known.lastSeen = Date.now()
      } else {
        panels.set(panelId, {
          id: panelId,
          sessionId,
          tabId: tabId || '',
          visible: Boolean(visible),
          lastSeen: Date.now(),
          inbox: createInbox(),
        })
        note('info', `панель подключилась: ${panelId} (сессия ${sessionId})`)
      }
      return { status: 200, body: { ok: true, version: PROTOCOL_VERSION } }
    }

    if (pathname === '/panel/bye' && method === 'POST') {
      const { panelId } = body || {}
      if (panelId && panels.delete(panelId)) note('info', `панель отключилась: ${panelId}`)
      return { status: 200, body: { ok: true } }
    }

    if (pathname === '/panel/poll') {
      const panel = panelById(query.get('panel') || '')
      if (!panel) {
        // Панель опрашивает мост до регистрации: пусть повторит hello.
        return { status: 200, body: {} }
      }
      const command = await take(panel.inbox, POLL_TIMEOUT_MS)
      return { status: 200, body: command || {} }
    }

    if (pathname === '/panel/reply' && method === 'POST') {
      const { id, ok, result } = body || {}
      const entry = id === undefined ? undefined : inflight.get(id)
      if (entry) {
        inflight.delete(id)
        clearTimeout(entry.timer)
        if (ok) entry.resolve(result ?? {})
        else entry.reject(new BridgeError('panel-error', (result && result.error) || 'команда не выполнена'))
      }
      return { status: 200, body: { ok: true } }
    }

    // --- сторона страницы DSH (сторож открытия) ---

    if (pathname === '/client/hello' && method === 'POST') {
      const clientId = (body && body.clientId) || randomUUID()
      const known = clients.get(clientId)
      if (known) known.lastSeen = Date.now()
      else clients.set(clientId, { id: clientId, lastSeen: Date.now(), inbox: createInbox() })
      return { status: 200, body: { ok: true, clientId, version: PROTOCOL_VERSION } }
    }

    if (pathname === '/client/poll') {
      const client = clients.get(query.get('client') || '')
      if (!client) return { status: 200, body: {} }
      client.lastSeen = Date.now()
      const command = await take(client.inbox, POLL_TIMEOUT_MS)
      return { status: 200, body: command || {} }
    }

    if (pathname === '/client/reply' && method === 'POST') {
      const { id, ok, result } = body || {}
      const entry = id === undefined ? undefined : controlInflight.get(id)
      if (entry) {
        // Команда ушла всем страницам: первая, у которой нашлась сессия,
        // отвечает `ok`, остальные — `not-mine`. Ждём первый содержательный
        // ответ и не считаем отказы чужих окон ошибкой.
        const notMine = result && result.code === 'not-mine'
        if (ok) {
          controlInflight.delete(id)
          clearTimeout(entry.timer)
          entry.resolve(result ?? {})
        } else if (notMine) {
          entry.remaining -= 1
          if (entry.remaining <= 0) {
            controlInflight.delete(id)
            clearTimeout(entry.timer)
            entry.reject(new BridgeError('not-mine', 'эта сессия не открыта ни в одном окне DSH'))
          }
        } else {
          controlInflight.delete(id)
          clearTimeout(entry.timer)
          entry.reject(new BridgeError('client-error', (result && result.error) || 'команда не выполнена'))
        }
      }
      return { status: 200, body: { ok: true } }
    }

    // --- сторона агента (инструменты) ---

    if (pathname === '/state') {
      return {
        status: 200,
        body: {
          ok: true,
          panels: [...panels.values()].map((panel) => ({
            id: panel.id,
            sessionId: panel.sessionId,
            tabId: panel.tabId,
            visible: panel.visible,
            idleMs: Date.now() - panel.lastSeen,
          })),
        },
      }
    }

    if (pathname === '/cmd' && method === 'POST') {
      const command = body || {}
      const { sessionId, panel: panelHint, tab: tabHint, ...rest } = command
      try {
        const panel = pickPanel(sessionId, { panel: panelHint, tab: tabHint })
        const result = await sendToPanel(panel, rest)
        return { status: 200, body: { ok: true, result: { ...result, panel: panel.id } } }
      } catch (error) {
        const known = error instanceof BridgeError
        return {
          status: 200,
          body: {
            ok: false,
            code: known ? error.code : 'error',
            error: error instanceof Error ? error.message : String(error),
            ...(known ? error.extra : {}),
          },
        }
      }
    }

    if (pathname === '/control' && method === 'POST') {
      const command = body || {}
      try {
        const result = await sendToClient(command)
        return { status: 200, body: { ok: true, result } }
      } catch (error) {
        const known = error instanceof BridgeError
        return {
          status: 200,
          body: {
            ok: false,
            code: known ? error.code : 'error',
            error: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }

    if (pathname === '/log' && method === 'POST') {
      note((body && body.level) || 'info', (body && body.message) || '')
      return { status: 200, body: { ok: true } }
    }

    if (pathname === '/logs') return { status: 200, body: { ok: true, entries: log } }

    return { status: 404, body: { ok: false, error: `неизвестный маршрут ${pathname}` } }
  }

  return {
    handle,
    note,
    /** Сменить стартовую страницу (например, после правки конфига). */
    setStartUrl(url) {
      if (typeof url === 'string' && url) startUrl = url
    },
    get panels() {
      return [...panels.values()]
    },
    get logs() {
      return log
    },
    /** Есть ли панель в этой сессии. */
    hasPanel(sessionId) {
      return panelsOf(sessionId).length > 0
    },
    /** Сколько команд сейчас в полёте — для диагностики. */
    get inflightCount() {
      return inflight.size
    },
    /** Очередь непуста — панель проснётся на следующем опросе. */
    isQueued(panelId) {
      const panel = panels.get(panelId)
      return panel ? hasQueued(panel.inbox) : false
    },
  }
}

/**
 * Прочитать JSON-тело запроса с ограничением размера.
 *
 * Предел защищает от того, кто пришлёт гигабайт в теле: без него один запрос
 * может съесть память процесса.
 * @param req - входящий запрос.
 * @returns разобранное тело; `{}` для пустого или битого JSON, `undefined` при превышении предела.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    return {}
  }
}

/** Есть ли у запроса loopback-адрес. */
function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Транспорт поверх собственного loopback-сервера.
 *
 * Нужен там, где у DSH нет встроенного веб-сервера (например, окно Electron
 * открыто через file://). Слушает только 127.0.0.1 и требует токен: без него
 * любой процесс на машине мог бы управлять браузером.
 * @param bridge - мост из {@link createBridge}.
 * @param options - `port` (0 — любой свободный), `host`, `token`, `basePath`.
 * @returns `{ server, port, base, close }`.
 */
export async function startLoopbackTransport(bridge, options = {}) {
  const { createServer } = await import('node:http')
  const port = Number.isFinite(options.port) ? Number(options.port) : 0
  const host = options.host || '127.0.0.1'
  const basePath = options.basePath || '/dsh-agent-browser'
  // Токен обязателен: без него мост открыт любому локальному процессу.
  const token = options.token || randomUUID()

  const cors = {
    'access-control-allow-origin': 'null',
    'access-control-allow-headers': 'content-type,x-agent-browser-token',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-max-age': '600',
  }

  const server = createServer(async (req, res) => {
    const deny = (status, error) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...cors })
      res.end(JSON.stringify({ ok: false, error }))
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || host}`)
    if (!url.pathname.startsWith(basePath)) return deny(404, 'not found')
    // Только этот компьютер: сервер не должен стать точкой управления
    // браузером для кого-то ещё в сети, даже если порт окажется открыт.
    if (!isLoopbackRequest(req)) return deny(403, 'forbidden')
    // Предварительный запрос CORS: страница на file:// имеет origin `null`.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      res.end()
      return
    }
    const pathname = url.pathname.slice(basePath.length) || '/'
    // Клиент берёт здесь токен, если не получил его через index.html.
    // CORS разрешает только origin `null` (страница на file://), поэтому
    // прочитать ответ из обычного сайта нельзя.
    if (pathname === '/bootstrap') {
      // Host проверяем отдельно: при DNS-rebinding браузер считает запрос
      // same-origin, и разрешённый origin `null` уже не спасает.
      const hostName = String(req.headers.host || '').replace(/:\d+$/, '')
      const localHost =
        hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '[::1]' || hostName === '::1' || hostName === ''
      if (!localHost) return deny(403, 'forbidden')
      // Межсайтовый запрос браузер помечает `cross-site`: токен ему не отдаём.
      const site = req.headers['sec-fetch-site']
      if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return deny(403, 'forbidden')
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        ...cors,
      })
      res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION, token, base: basePath }))
      return
    }
    if (req.headers['x-agent-browser-token'] !== token) return deny(403, 'forbidden')
    const body = req.method === 'POST' ? await readJsonBody(req) : {}
    if (body === undefined) return deny(413, 'payload too large')
    const answer = await bridge.handle(req.method || 'GET', pathname, url.searchParams, body)
    res.writeHead(answer.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors,
    })
    res.end(JSON.stringify(answer.body))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      resolve(undefined)
    })
  })

  const actualPort = server.address().port
  return {
    server,
    port: actualPort,
    base: `http://${host}:${actualPort}${basePath}`,
    token,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve(undefined))
      }),
  }
}
