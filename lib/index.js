// Серверная половина плагина «Браузер агента».
//
// Регистрирует инструменты, которыми агент управляет браузером в правой
// панели, и поднимает мост между инструментами и панелями.
//
// Ключевое отличие от «одного общего браузера»: каждая панель принадлежит
// сессии, а инструмент знает сессию своего агента (`exec.agent.id`). Поэтому
// команда всегда уходит в браузер той сессии, где работает агент, — даже если
// одновременно работают несколько агентов в разных чатах.

import { appendFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { createBridge, PROTOCOL_VERSION, readJsonBody, startLoopbackTransport } from './bridge.mjs'

export const name = 'agent-browser'
export const inject = ['tools']

/** Базовый путь моста: и на встроенном веб-сервере, и на собственном. */
const BASE_PATH = '/dsh-agent-browser'

/** Настройки по умолчанию. Всё переопределяется через `config` в cordis.patch.yml. */
const DEFAULTS = {
  /** Стартовая страница новой панели. */
  startUrl: 'https://www.google.com',
  /** Язык текстов плагина: auto | ru | en. `auto` — по локали системы. */
  language: 'auto',
  /** Переключать ли чат на сессию агента, когда панель открывается. */
  focusOnOpen: true,
  /** Открывать панель автоматически, если инструмент вызван, а панели нет. */
  autoOpen: true,
  /** UA обычного Chrome: встроенный Chromium иначе выдаёт себя строкой Electron. */
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  /** Сколько ждать ответа браузера на одну команду. */
  timeoutMs: 30_000,
  /** Сколько ждать, пока открытая панель появится на мосту. */
  openTimeoutMs: 20_000,
  /** Порт собственного сервера, когда у DSH нет встроенного (0 — любой свободный). */
  port: 0,
  /** Писать ли отладочные строки в журнал. */
  debug: true,
  /** Свой путь журнала; по умолчанию — во временной папке. */
  logFile: '',
}

/** Тексты, которые видит модель и пользователь. */
const MESSAGES = {
  ru: {
    opened: 'Вкладка «Браузер агента» открыта в этом чате справа.',
    alreadyOpen: 'Браузер уже открыт в этом чате.',
    revealed: 'Рабочая вкладка «Браузер агента» выведена на экран.',
    closed: 'Вкладка «Браузер агента» закрыта.',
    noPanels: 'Открытых вкладок «Браузер агента» нет.',
    notReady:
      'Браузер не успел открыться. Подождите пару секунд и повторите: панель ещё поднимается.',
    emptyValue: 'Ошибка: пустое значение.',
    unknownCommand: 'Ошибка: неизвестная команда.',
    screenshotSaved: 'Скриншот сохранён',
    visibleArea: 'видимая область',
  },
  en: {
    opened: 'The Agent Browser tab is now open in this chat, on the right.',
    alreadyOpen: 'The browser is already open in this chat.',
    revealed: 'The working Agent Browser tab is now on screen.',
    closed: 'The Agent Browser tab is closed.',
    noPanels: 'No Agent Browser tab is open.',
    notReady: 'The browser did not finish opening. Wait a couple of seconds and try again.',
    emptyValue: 'Error: empty value.',
    unknownCommand: 'Error: unknown command.',
    screenshotSaved: 'Screenshot saved',
    visibleArea: 'visible area',
  },
}

/** Клавиши, которые умеет нажимать браузер. */
const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
}

/** Куда складывать скриншоты, если путь не задан. */
const SHOT_DIR = join(tmpdir(), 'dsh-agent-browser')

/**
 * Рабочий каталог сессии агента.
 *
 * Берём из заголовка сессии (`session.header.cwd`), а если его нет — текущий
 * каталог процесса. Нужен, чтобы разрешить запись скриншотов в рабочую папку.
 * @param exec - контекст вызова инструмента.
 * @returns абсолютный путь каталога.
 */
function workspaceOf(exec) {
  try {
    const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header && exec.agent.session.header.cwd
    if (typeof cwd === 'string' && cwd) return cwd
  } catch {
    /* сессия без заголовка */
  }
  return process.cwd()
}

/**
 * Проверить и привести путь скриншота.
 *
 * Инструмент пишет файл напрямую, минуя файловую политику DSH, поэтому сам
 * ограничивает, куда писать: только временная папка скриншотов и рабочий
 * каталог сессии. Иначе агент мог бы перезаписать произвольный файл на диске
 * (например, чужой конфиг), и никакой sandbox бы этого не заметил.
 * @param raw - путь, который передал агент.
 * @param exec - контекст вызова (нужен рабочий каталог).
 * @returns абсолютный путь внутри разрешённой папки.
 * @throws ToolError, когда путь выходит за пределы разрешённых папок.
 */
function resolveShotPath(raw, exec) {
  const target = resolve(raw)
  const roots = [resolve(SHOT_DIR), resolve(workspaceOf(exec))]
  const allowed = roots.some((root) => target === root || target.startsWith(root + sep))
  if (!allowed) {
    throw new ToolError(
      'path-not-allowed',
      `писать можно только в папку скриншотов (${SHOT_DIR}) и рабочий каталог сессии, а не в ${target}`,
    )
  }
  return target
}

/** Задержка. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Текстовый блок результата инструмента. */
function text(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

/** Ошибка инструмента с машинным кодом: код виден в журнале, текст — модели. */
class ToolError extends Error {
  /**
   * @param code - машинный код (`browser-not-ready`, `bridge-down`, …).
   * @param message - текст для человека.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ToolError'
    this.code = code
  }
}

/** Определить язык по настройке или по локали системы. */
function resolveLanguage(setting) {
  if (setting === 'ru' || setting === 'en') return setting
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale || ''
    return /^ru\b/i.test(locale) ? 'ru' : 'en'
  } catch {
    return 'en'
  }
}

/**
 * Проверить и дополнить настройки.
 * @param raw - то, что пришло из конфига плагина.
 * @returns настройки со всеми полями.
 */
function readConfig(raw) {
  const config = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (typeof config.startUrl !== 'string' || !config.startUrl.trim()) config.startUrl = DEFAULTS.startUrl
  if (!['auto', 'ru', 'en'].includes(config.language)) config.language = DEFAULTS.language
  config.focusOnOpen = config.focusOnOpen !== false
  config.autoOpen = config.autoOpen !== false
  config.debug = config.debug !== false
  const timeout = Number(config.timeoutMs)
  config.timeoutMs = timeout > 0 ? Math.min(300_000, timeout) : DEFAULTS.timeoutMs
  const openTimeout = Number(config.openTimeoutMs)
  config.openTimeoutMs = openTimeout > 0 ? Math.min(120_000, openTimeout) : DEFAULTS.openTimeoutMs
  const port = Number(config.port)
  config.port = Number.isFinite(port) && port >= 0 ? Math.floor(port) : 0
  if (typeof config.userAgent !== 'string' || !config.userAgent.trim()) config.userAgent = DEFAULTS.userAgent
  return config
}

/**
 * Журнал плагина: один файл с ротацией по размеру.
 *
 * Всё, что не удалось записать, молча теряется: журнал не должен ломать
 * работу браузера.
 */
function createLogger(config) {
  const file =
    typeof config.logFile === 'string' && config.logFile.trim()
      ? config.logFile.trim()
      : join(tmpdir(), 'dsh-agent-browser.log')
  const limit = 2 * 1024 * 1024

  return {
    file,
    /** Записать строку журнала. */
    write(level, message) {
      if (!config.debug && level === 'debug') return
      try {
        try {
          if (statSync(file).size > limit) renameSync(file, `${file}.1`)
        } catch {
          /* файла ещё нет — поворачивать нечего */
        }
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8')
      } catch {
        /* журнал недоступен */
      }
    },
  }
}

/**
 * Собрать сигнал отмены для запроса к мосту.
 * @param exec - контекст выполнения инструмента.
 * @param timeoutMs - собственный таймаут запроса.
 * @returns сигнал, срабатывающий по любому из поводов.
 */
function signalFor(exec, timeoutMs) {
  const signals = [AbortSignal.timeout(timeoutMs)]
  if (exec && exec.signal) signals.push(exec.signal)
  try {
    return AbortSignal.any(signals)
  } catch {
    return signals[0]
  }
}

/**
 * Взять сервис веб-сервера, если он есть.
 *
 * Читаем через `ctx.reflect.get`, а не через `inject`: тогда плагин грузится и
 * там, где встроенного сервера нет (например, окно на file://), и поднимает
 * собственный. `inject` в Cordis только обязательный — объяви мы `webServer`
 * там, плагин бы просто не загрузился без него.
 * @param ctx - контекст плагина.
 * @returns сервис или `undefined`.
 */
function webServerOf(ctx) {
  try {
    return (ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('webServer') : undefined) || undefined
  } catch {
    return undefined
  }
}

/**
 * Поднять транспорт моста.
 *
 * Основной путь — маршрут на встроенном веб-сервере DSH: тот же origin, что у
 * страницы, никаких портов, CORS и конфликтов между двумя окнами DSH.
 * Если веб-сервера нет (окно открыто через file://), поднимаем собственный
 * сервер на 127.0.0.1 и сообщаем клиенту адрес через index.html.
 */
async function startTransport(ctx, bridge, config, log, token) {
  // Веб-сервер монтируется раньше плагинов, но порядок загрузки не гарантирован.
  let webServer
  for (let attempt = 0; attempt < 20; attempt++) {
    webServer = webServerOf(ctx)
    if (webServer && typeof webServer.register === 'function') break
    await sleep(150)
  }

  if (webServer && typeof webServer.register === 'function') {
    let origin = 'http://127.0.0.1'
    try {
      origin = webServer.getOrigin()
    } catch {
      /* сервер ещё не слушает: origin нужен только для разбора URL */
    }
    const dispose = webServer.register({
      kind: 'prefix',
      path: BASE_PATH,
      handler: async (req, res) => {
        const deny = (status, error) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error }))
        }
        const url = new URL(req.url || '/', origin)
        // Только этот компьютер. DSH умеет слушать сеть — тогда мост не должен
        // становиться точкой управления браузером для соседей по сети.
        const remote = (req.socket && req.socket.remoteAddress) || ''
        if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
          return deny(403, 'forbidden')
        }
        const pathname = url.pathname.slice(BASE_PATH.length) || '/'

        // Клиент берёт здесь токен, если не получил его через index.html.
        // Ответ намеренно без CORS-заголовков: прочитать его может только
        // страница этого же origin, то есть сам DSH. Чужой сайт получит тело,
        // но не сможет его прочитать, поэтому токен не утечёт.
        //
        // Две дополнительные проверки:
        //   Host — при DNS-rebinding браузер считает запрос same-origin, и тело
        //   стало бы читаемым; слушаем только loopback-имена;
        //   Sec-Fetch-Site — браузер помечает межсайтовый запрос как `cross-site`,
        //   а свой — `same-origin`/`none`. Так страница чужого сайта токен не получит.
        if (pathname === '/bootstrap') {
          const hostName = String(req.headers.host || '').replace(/:\d+$/, '')
          const localHost =
            hostName === '127.0.0.1' ||
            hostName === 'localhost' ||
            hostName === '[::1]' ||
            hostName === '::1' ||
            hostName === ''
          if (!localHost) return deny(403, 'forbidden')
          const site = req.headers['sec-fetch-site']
          if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
            return deny(403, 'forbidden')
          }
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            vary: 'origin',
          })
          res.end(JSON.stringify({ ok: true, version: PROTOCOL_VERSION, token, base: BASE_PATH }))
          return
        }

        // Токен только в заголовке: в строке запроса он попал бы в журналы.
        if (token && req.headers['x-agent-browser-token'] !== token) return deny(403, 'forbidden')
        const body = req.method === 'POST' ? await readJsonBody(req) : {}
        if (body === undefined) return deny(413, 'payload too large')
        const answer = await bridge.handle(req.method || 'GET', pathname, url.searchParams, body)
        res.writeHead(answer.status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(answer.body))
      },
    })
    log.write('info', `транспорт: маршрут встроенного веб-сервера ${BASE_PATH}`)
    return { base: BASE_PATH, hostBase: `${origin.replace(/\/$/, '')}${BASE_PATH}`, dispose }
  }

  const transport = await startLoopbackTransport(bridge, {
    port: config.port,
    host: '127.0.0.1',
    basePath: BASE_PATH,
    token,
  })
  log.write('info', `транспорт: собственный сервер ${transport.base}`)
  // Клиент и хост ходят по одному адресу: origin у них общий.
  return { base: transport.base, hostBase: transport.base, dispose: () => void transport.close() }
}

/**
 * Скрипт-сторож для страницы.
 *
 * Плагин состоит из двух половин. Серверная подхватывается на лету, а
 * клиентская попадает в сборку страницы только при её загрузке. Если плагин
 * включили в уже открытом окне, клиентской половины в нём нет — и без
 * подсказки пользователь видит лишь «ничего не работает».
 *
 * Сторож ставится в index.html серверной половиной (она-то уже загружена) и
 * через несколько секунд проверяет, отметилась ли клиентская. Если нет —
 * показывает баннер с кнопкой перезагрузки. Всё на чистом DOM: React на этом
 * этапе ещё может быть не готов.
 *
 * Скрипт намеренно короткий и защищённый: любая ошибка внутри гасится, чтобы
 * он не мог сломать загрузку приложения.
 * @param token - токен моста, чтобы отметить, чей это сторож.
 * @returns текст тега script.
 */
function watchdogScript(token) {
  const banner = `
(function () {
  try {
    var DSH = window.__DSH_AGENT_BROWSER__ || {};
    var TOKEN = ${JSON.stringify(String(token))};
    function show() {
      try {
        if (window.__DSH_AGENT_BROWSER_CLIENT__) return;
        if (document.getElementById('dsh-agent-browser-reload')) return;
        var box = document.createElement('div');
        box.id = 'dsh-agent-browser-reload';
        box.setAttribute('role', 'status');
        box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:360px;display:flex;gap:10px;align-items:flex-start;padding:12px 14px;border-radius:10px;background:#1b1f27;border:1px solid #3a4150;box-shadow:0 8px 24px rgba(0,0,0,.35);color:#c9d1e0;font:400 12.5px/1.5 system-ui,sans-serif';
        var text = document.createElement('div');
        text.style.cssText = 'flex:1;min-width:0';
        var head = document.createElement('div');
        head.style.cssText = 'font-weight:600;margin-bottom:2px';
        head.textContent = 'Браузер агента';
        var body = document.createElement('div');
        body.style.cssText = 'color:#8b93a1';
        body.textContent = 'Плагин включён, но окно открыто со старой сборкой. Нажмите «Перезагрузить», чтобы браузер заработал.';
        text.appendChild(head);
        text.appendChild(body);
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Перезагрузить';
        button.style.cssText = 'flex:none;cursor:pointer;border:1px solid #3a4150;border-radius:6px;background:#232833;color:#c9d1e0;font-size:12px;padding:5px 10px';
        button.onclick = function () { try { location.reload(); } catch (e) {} };
        box.appendChild(text);
        box.appendChild(button);
        (document.body || document.documentElement).appendChild(box);
      } catch (e) {}
    }
    // Дать приложению и клиентской половине шанс загрузиться.
    setTimeout(show, 7000);
  } catch (e) {}
})();
`

  return `<script>${banner.replace(/<\/script/gi, '<\\/script')}</script>`
}

/**
 * Отдать клиентской половине адрес моста и токен.
 *
 * Клиент живёт в браузере и не видит настройки хоста, поэтому адрес и токен
 * попадают в index.html до загрузки приложения. Туда же кладётся сторож,
 * который подскажет перезагрузить окно, если клиентская половина не загрузилась.
 * @returns функция снятия вставки.
 */
function injectBootstrap(ctx, base, token, log) {
  const webServer = webServerOf(ctx)
  // Веб-сервер ещё не смонтирован — вернём null, чтобы вызывающий попробовал
  // позже, а не считал вставку уже сделанной.
  if (!webServer || typeof webServer.tapIndex !== 'function') return null
  // JSON.stringify не экранирует `</script>`: без замены строка с ним закрыла бы
  // тег раньше времени. Данные здесь свои, но правило дешевле исключения.
  const payload = JSON.stringify({ version: PROTOCOL_VERSION, base, token }).replace(/</g, '\\u003c')
  const snippet = `<script>window.__DSH_AGENT_BROWSER__=${payload}</script>${watchdogScript(token)}`
  const dispose = webServer.tapIndex((html) =>
    html.includes('</head>') ? html.replace('</head>', `${snippet}</head>`) : snippet + html,
  )
  log.write('info', 'клиент получит адрес моста через index.html')
  return dispose
}

/**
 * Создать инструменты.
 * @param bridge - мост.
 * @param config - настройки.
 * @param log - журнал.
 * @param getBase - функция, возвращающая `{ url, token }` текущего транспорта.
 * @param t - тексты на выбранном языке.
 */
function createTools(bridge, config, log, getBase, t) {
  /** Запрос к мосту. */
  async function request(pathname, { method = 'GET', body, exec, timeoutMs } = {}) {
    const base = getBase()
    if (!base) {
      throw new ToolError(
        'bridge-down',
        'мост браузера не поднялся. Перезапустите DSH и проверьте журнал плагина.',
      )
    }
    const headers = { 'content-type': 'application/json' }
    if (base.token) headers['x-agent-browser-token'] = base.token
    let response
    try {
      response = await fetch(`${base.url}${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signalFor(exec, timeoutMs || config.timeoutMs + 15_000),
      })
    } catch (error) {
      if (exec && exec.signal && exec.signal.aborted) throw new ToolError('aborted', 'вызов отменён')
      throw new ToolError(
        'bridge-down',
        `мост браузера не отвечает: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!response.ok) throw new ToolError('bridge-http', `мост ответил ${response.status}`)
    return response.json()
  }

  /** Сессия агента, от имени которого вызван инструмент. */
  function sessionOf(exec) {
    const id = exec && exec.agent && exec.agent.id
    return id === undefined || id === null ? undefined : String(id)
  }

  /** Управляющая команда странице DSH: открыть, показать или закрыть вкладку. */
  async function control(command, exec) {
    const data = await request('/control', { method: 'POST', body: command, exec })
    if (!data.ok) {
      const code = data.code || 'control-failed'
      throw new ToolError(code, data.error || 'страница DSH не выполнила команду')
    }
    return data.result || {}
  }

  /** Дождаться, пока открытая панель выйдет на связь. */
  async function waitForPanel(sessionId, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || config.openTimeoutMs)
    while (Date.now() < deadline) {
      if (bridge.hasPanel(sessionId)) return true
      await sleep(100)
    }
    return false
  }

  /** Открыть панель в сессии агента, если её ещё нет. */
  async function ensurePanel(exec) {
    const sessionId = sessionOf(exec)
    if (bridge.hasPanel(sessionId)) return sessionId
    if (!config.autoOpen) {
      throw new ToolError('no-panel', 'браузер в этом чате не открыт — вызовите browser_open')
    }
    await control({ type: 'open', sessionId, focus: config.focusOnOpen }, exec)
    if (!(await waitForPanel(sessionId))) throw new ToolError('browser-not-ready', t.notReady)
    log.write('info', `панель открыта для сессии ${sessionId ?? '(текущая)'}`)
    return sessionId
  }

  /** Команда браузеру этой сессии. */
  async function call(command, exec, options = {}) {
    const sessionId = await ensurePanel(exec)
    const data = await request('/cmd', {
      method: 'POST',
      body: { ...command, sessionId },
      exec,
      timeoutMs: options.timeoutMs,
    })
    if (!data.ok) throw new ToolError(data.code || 'command-failed', data.error || 'команда не выполнена')
    return data.result || {}
  }

  /** Разобрать JSON-строку из ответа страницы, не падая на мусоре. */
  function parse(value, fallback) {
    try {
      return JSON.parse(String(value))
    } catch {
      return fallback
    }
  }

  /** Склеить короткое имя сессии для отчётов. */
  function shortSession(sessionId) {
    const value = String(sessionId || '')
    return value.length > 12 ? `${value.slice(0, 8)}…` : value || '(неизвестна)'
  }

  return [
    {
      name: 'browser_open',
      description:
        'Open the Agent Browser tab in the right panel of the chat this agent runs in. Call it first when no browser is open: every other browser command needs an open tab. Each chat has its own independent browser.',
      parameters: {},
      run: async (_args, exec) => {
        const sessionId = sessionOf(exec)
        if (bridge.hasPanel(sessionId)) {
          const result = await control({ type: 'reveal', sessionId, focus: true }, exec)
          return `${t.alreadyOpen}${result.revealed ? ` (вкладка ${result.revealed})` : ''}`
        }
        await control({ type: 'open', sessionId, focus: config.focusOnOpen }, exec)
        if (!(await waitForPanel(sessionId))) {
          return `Панель открывается, но ещё не готова. ${t.notReady}`
        }
        return t.opened
      },
    },
    {
      name: 'browser_reveal',
      description:
        'Show the Agent Browser tab of this chat on screen without opening a second one and without changing which tab receives commands.',
      parameters: {},
      run: async (_args, exec) => {
        const sessionId = await ensurePanel(exec)
        const result = await control({ type: 'reveal', sessionId, focus: true }, exec)
        return `${t.revealed}${result.revealed ? ` Вкладка: ${result.revealed}` : ''}`
      },
    },
    {
      name: 'browser_close',
      description:
        'Close the Agent Browser tab of this chat. The page, its history and its cookies stay in the browser profile; the tab itself is gone.',
      parameters: {},
      run: async (_args, exec) => {
        const sessionId = sessionOf(exec)
        if (!bridge.hasPanel(sessionId)) return 'В этом чате браузер и так не открыт.'
        await control({ type: 'close', sessionId }, exec)
        await sleep(200)
        return t.closed
      },
    },
    {
      name: 'browser_tabs',
      description:
        'List every open Agent Browser tab across all chats, with the chat each belongs to and which one receives this agent commands.',
      parameters: {},
      run: async (_args, exec) => {
        const sessionId = sessionOf(exec)
        const data = await request('/state', { exec })
        const panels = Array.isArray(data.panels) ? data.panels : []
        if (panels.length === 0) return `${t.noPanels} Вызовите browser_open.`
        const lines = panels.map((panel, index) => {
          const mine = panel.sessionId === sessionId ? ' [команды этого агента идут сюда]' : ''
          const where = panel.visible ? 'на экране' : 'в фоне'
          const idle = Math.round(Number(panel.idleMs) / 1000)
          return `${index + 1}. сессия ${shortSession(panel.sessionId)} — ${where}${mine}, активна ${idle} с назад`
        })
        return `Вкладок: ${panels.length}\n${lines.join('\n')}`
      },
    },
    {
      name: 'browser_status',
      description:
        'Check that the built-in browser answers, and which page is open in this chat. Also diagnoses a half-loaded plugin and says exactly what to do.',
      parameters: {},
      run: async (_args, exec) => {
        // Сначала проверяем, что вообще есть с кем говорить: если клиентская
        // половина не загрузилась, любая команда даст лишь «обновите окно», и
        // лучше сказать это сразу, чем гонять пользователя по кругу.
        const health = await request('/health', { exec }).catch(() => null)
        if (!health) {
          return (
            'Мост браузера не отвечает: серверная половина плагина не поднялась.\n' +
            `Проверьте журнал: ${log.file}\n` +
            'Если в нём «транспорт не поднялся» — перезапустите DeepSeek Harness.'
          )
        }
        if (!health.clients) {
          return (
            'Плагин загружен наполовину: серверная часть работает, а клиентская в окне — нет.\n' +
            'Это бывает, когда плагин включили уже после запуска приложения.\n\n' +
            'Что сделать: нажмите Ctrl+R (перезагрузка окна). Если не помогло — перезапустите DeepSeek Harness.\n' +
            `Версия протокола: ${health.version}, панелей: ${health.panels}, окон: ${health.clients}`
          )
        }
        const info = await call({ type: 'url' }, exec)
        return `Встроенный браузер доступен.\nВкладка: ${info.panel || '(не указана)'}\nURL: ${info.url}\nЗаголовок: ${info.title || '(без заголовка)'}`
      },
    },
    {
      name: 'browser_navigate',
      description:
        'Open an address in the built-in browser of this chat. The user sees the same page and can work with it directly. Resolves once the page has loaded.',
      parameters: {
        url: { type: 'string', required: true, description: 'Page address' },
      },
      run: async (args, exec) => {
        let url = String(args.url || '').trim()
        if (!url) return t.emptyValue
        if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^about:/i.test(url)) url = 'https://' + url
        const info = await call({ type: 'navigate', url }, exec, { timeoutMs: 60_000 })
        return `Открыто: ${info.url || url}\nЗаголовок: ${info.title || '(без заголовка)'}`
      },
    },
    {
      name: 'browser_read',
      description:
        'Read the current page: address, title and visible text. The main way to see what is on the page.',
      parameters: {
        limit: { type: 'integer', description: 'How many characters of text to return (default 8000)' },
      },
      run: async (args, exec) => {
        const limit = Number(args.limit) > 0 ? Math.min(400_000, Number(args.limit)) : 8000
        const info = await call({ type: 'url' }, exec)
        const body = await call({ type: 'text' }, exec)
        const visible = String(body.text || '').trim()
        const cut = visible.slice(0, limit)
        const tail = visible.length > limit ? `\n…обрезано (всего ${visible.length} символов)` : ''
        return `URL: ${info.url}\nЗаголовок: ${info.title || '(без заголовка)'}\n\n${cut}${tail}`
      },
    },
    {
      name: 'browser_html',
      description: 'Return the HTML of the current page. Read the text with browser_read first: HTML is large.',
      parameters: {
        limit: { type: 'integer', description: 'How many characters to return (default 200000)' },
      },
      run: async (args, exec) => {
        const limit = Number(args.limit) > 0 ? Math.min(2_000_000, Number(args.limit)) : 200_000
        const body = await call({ type: 'html' }, exec)
        const html = String(body.html || '')
        return html.length > limit ? `${html.slice(0, limit)}\n…обрезано (всего ${html.length} символов)` : html
      },
    },
    {
      name: 'browser_eval',
      description:
        'Run JavaScript on the current page and return the result. Use it for precise actions and data extraction.',
      parameters: {
        code: { type: 'string', required: true, description: 'Expression or function body' },
      },
      run: async (args, exec) => {
        const code = String(args.code || '')
        if (!code.trim()) return t.emptyValue
        const result = await call({ type: 'eval', code }, exec)
        if (result.value === undefined) return 'undefined'
        return typeof result.value === 'string' ? result.value : JSON.stringify(result.value, null, 2)
      },
    },
    {
      name: 'browser_click',
      description:
        'Click an element by its visible text — the main way to press a link or a button. Matches visible text, aria-label and field placeholder.',
      parameters: {
        text: { type: 'string', required: true, description: 'Element text' },
        nth: { type: 'integer', description: 'Which match to use, zero-based' },
      },
      run: async (args, exec) => {
        const needle = String(args.text || '')
        if (!needle) return t.emptyValue
        const nth = Number(args.nth) >= 0 ? Math.round(Number(args.nth)) : 0
        const result = await call({ type: 'find', text: needle, nth }, exec)
        const data = parse(result.value, undefined)
        if (!data) return String(result.value)
        if (!data.found) {
          return `Не найдено элементов с текстом «${needle}». Подходящих на экране: ${data.total}`
        }
        await sleep(300)
        return `Клик по «${data.label}» (${data.x}, ${data.y}). Подходящих: ${data.total}`
      },
    },
    {
      name: 'browser_click_at',
      description: 'Click at a point of the page, in pixels from the top-left corner of the browser view.',
      parameters: {
        x: { type: 'integer', required: true, description: 'X' },
        y: { type: 'integer', required: true, description: 'Y' },
      },
      run: async (args, exec) => {
        const result = await call(
          { type: 'clickAt', x: Math.round(Number(args.x) || 0), y: Math.round(Number(args.y) || 0) },
          exec,
        )
        await sleep(200)
        return String(result.value)
      },
    },
    {
      name: 'browser_mouse_click',
      description:
        'Click with a real Chromium mouse event at a point (unlike browser_click_at, whose click is synthetic). Needed for captchas that check event trust.',
      parameters: {
        x: { type: 'integer', required: true, description: 'X' },
        y: { type: 'integer', required: true, description: 'Y' },
      },
      run: async (args, exec) => {
        const x = Math.round(Number(args.x) || 0)
        const y = Math.round(Number(args.y) || 0)
        await call({ type: 'mouseClick', x, y }, exec)
        await sleep(150)
        return `Клик мышью в (${x}, ${y})`
      },
    },
    {
      name: 'browser_type',
      description:
        'Type text into a field. Without a selector, uses the focused field or the first search field on the page.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text' },
        selector: { type: 'string', description: 'CSS selector of the field (optional)' },
        submit: { type: 'boolean', description: 'Submit the form after typing (Enter)' },
      },
      run: async (args, exec) => {
        const value = String(args.text ?? '')
        const selector = typeof args.selector === 'string' && args.selector ? args.selector : ''
        const result = await call({ type: 'type', text: value, selector }, exec)
        const data = parse(result.value, undefined)
        if (!data) return String(result.value)
        if (!data.ok) return `Ошибка: ${data.reason}`
        const where = `<${data.tag}${data.name ? ' name=' + data.name : ''}>`
        if (args.submit !== true) return `Введено в ${where}: «${data.value}»`
        const sent = await call({ type: 'submit' }, exec)
        await sleep(900)
        const info = await call({ type: 'url' }, exec)
        return `Введено «${data.value}» и отправлено (${sent.value || 'ok'}).\nURL: ${info.url}`
      },
    },
    {
      name: 'browser_key',
      description: 'Press a key: Enter, Escape, Tab, ArrowDown, PageDown and so on.',
      parameters: {
        key: { type: 'string', required: true, description: 'Key name' },
      },
      run: async (args, exec) => {
        const key = String(args.key || '')
        if (!KEY_CODES[key]) {
          return `Неизвестная клавиша «${key}». Доступны: ${Object.keys(KEY_CODES).join(', ')}`
        }
        const result = await call({ type: 'key', key, code: KEY_CODES[key] }, exec)
        await sleep(120)
        return String(result.value)
      },
    },
    {
      name: 'browser_scroll',
      description: 'Scroll the page vertically.',
      parameters: {
        deltaY: { type: 'integer', required: true, description: 'Pixels: positive scrolls down, negative up' },
      },
      run: async (args, exec) => {
        const deltaY = Math.round(Number(args.deltaY) || 0)
        const result = await call({ type: 'scroll', deltaY }, exec)
        const data = parse(result.value, undefined)
        if (!data) return `Прокручено на ${deltaY}`
        return `Прокручено на ${deltaY}. Позиция ${data.y} из ${Math.max(0, data.h - data.vh)}`
      },
    },
    {
      name: 'browser_back',
      description: 'Go back to the previous page.',
      parameters: {},
      run: async (_args, exec) => {
        const result = await call({ type: 'back' }, exec)
        await sleep(300)
        return `Назад: ${result.url || ''}`
      },
    },
    {
      name: 'browser_forward',
      description: 'Go forward to the next page.',
      parameters: {},
      run: async (_args, exec) => {
        const result = await call({ type: 'forward' }, exec)
        await sleep(300)
        return `Вперёд: ${result.url || ''}`
      },
    },
    {
      name: 'browser_reload',
      description: 'Reload the current page.',
      parameters: {},
      run: async (_args, exec) => {
        const result = await call({ type: 'reload' }, exec, { timeoutMs: 60_000 })
        return `Страница обновлена: ${result.url || ''}`
      },
    },
    {
      name: 'browser_wait',
      description:
        'Wait for a CSS selector or a text to appear on the page, or just pause. Needed after navigation and after clicking a captcha.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        text: { type: 'string', description: 'Text to wait for' },
        ms: { type: 'integer', description: 'Timeout in milliseconds (default 8000)' },
      },
      run: async (args, exec) => {
        const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
        const needle = typeof args.text === 'string' ? args.text : ''
        const timeout = Number(args.ms) > 0 ? Math.min(120_000, Math.round(Number(args.ms))) : 8000
        if (!selector && !needle) {
          await sleep(timeout)
          return `Пауза ${timeout} мс`
        }
        const result = await call({ type: 'wait', selector, text: needle, timeoutMs: timeout }, exec, {
          timeoutMs: timeout + 20_000,
        })
        const what = selector ? `селектор ${selector}` : `текст «${needle}»`
        if (result.found) return `Дождались за ${result.waitedMs} мс: ${what}`
        return `Не появилось за ${timeout} мс: ${what}. Проверьте browser_read и признак стены.`
      },
    },
    {
      name: 'browser_screenshot',
      description:
        'Take a screenshot of the browser area and save it as a PNG file. Then look at the image with read_image — that is the only way to read a captcha, tiles and labels in a picture.',
      parameters: {
        path: { type: 'string', description: 'Where to save the PNG (default: a temporary file)' },
        x: { type: 'integer', description: 'Left edge of the area (optional)' },
        y: { type: 'integer', description: 'Top edge of the area (optional)' },
        width: { type: 'integer', description: 'Area width (optional)' },
        height: { type: 'integer', description: 'Area height (optional)' },
      },
      run: async (args, exec) => {
        const rect =
          Number(args.width) > 0 && Number(args.height) > 0
            ? {
                x: Math.round(Number(args.x) || 0),
                y: Math.round(Number(args.y) || 0),
                width: Math.round(Number(args.width)),
                height: Math.round(Number(args.height)),
              }
            : undefined
        const result = await call({ type: 'screenshot', rect }, exec)
        const dataUrl = String(result.dataUrl || '')
        const comma = dataUrl.indexOf(',')
        if (comma < 0) return 'Ошибка: браузер не вернул изображение'
        const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64')
        const target =
          typeof args.path === 'string' && args.path.trim()
            ? resolveShotPath(args.path.trim(), exec)
            : join(SHOT_DIR, `shot-${Date.now()}.png`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buffer)
        const where = rect ? `область ${rect.width}×${rect.height} при (${rect.x}, ${rect.y})` : t.visibleArea
        return `${t.screenshotSaved} (${where}): ${target}\nБайт: ${buffer.length}. Показать: read_image по этому пути.`
      },
    },
    {
      name: 'browser_drag',
      description:
        'Drag the mouse from one point to another with a human-like path. The main way to solve a slider captcha (Geetest and similar).',
      parameters: {
        fromX: { type: 'integer', required: true, description: 'X where the drag starts' },
        fromY: { type: 'integer', required: true, description: 'Y where the drag starts' },
        toX: { type: 'integer', required: true, description: 'X to drag to' },
        toY: { type: 'integer', required: true, description: 'Y to drag to' },
        steps: { type: 'integer', description: 'Number of movement steps (default 28)' },
      },
      run: async (args, exec) => {
        const result = await call(
          {
            type: 'drag',
            from: { x: Math.round(Number(args.fromX) || 0), y: Math.round(Number(args.fromY) || 0) },
            to: { x: Math.round(Number(args.toX) || 0), y: Math.round(Number(args.toY) || 0) },
            steps: Number(args.steps) || 28,
          },
          exec,
          { timeoutMs: 60_000 },
        )
        await sleep(400)
        return `Перетащил из (${result.from[0]}, ${result.from[1]}) в (${result.to[0]}, ${result.to[1]}), шагов: ${result.steps}`
      },
    },
    {
      name: 'browser_set_ua',
      description:
        'Replace the built-in browser User-Agent with a normal Chrome one and reload the page: by default Chromium identifies itself as Electron, and anti-bot systems notice it.',
      parameters: {
        ua: { type: 'string', description: 'UA string (default: a normal Chrome on Windows)' },
        reload: { type: 'boolean', description: 'Reload the page after the change (default yes)' },
      },
      run: async (args, exec) => {
        const ua = typeof args.ua === 'string' && args.ua.trim() ? args.ua.trim() : config.userAgent
        await call({ type: 'ua', ua, reload: args.reload !== false }, exec)
        await sleep(800)
        const check = await call({ type: 'eval', code: 'navigator.userAgent' }, exec)
        return `UA установлен: ${ua}\nСтраница сообщает: ${check.value || '(не удалось прочитать)'}`
      },
    },
  ]
}

/**
 * Точка входа плагина.
 * @param ctx - контекст Cordis (сервис `tools` доступен благодаря `inject`).
 * @param rawConfig - настройки из `cordis.patch.yml`.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const language = resolveLanguage(config.language)
  const log = createLogger(config)
  const t = MESSAGES[language]

  // Мост и его адрес переживают горячую перезагрузку плагина: панели в браузере
  // остаются подключёнными, а новый экземпляр плагина продолжает ими управлять.
  const bridge = (globalThis.__dshAgentBrowserBridge ||= createBridge({ startUrl: config.startUrl }))
  bridge.setStartUrl?.(config.startUrl)
  const state = (globalThis.__dshAgentBrowserState ||= {
    base: null,
    hostBase: null,
    token: '',
    dispose: null,
    inject: null,
  })
  if (!state.token) state.token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

  /** Текущий транспорт для инструментов: адрес всегда абсолютный. */
  const getBase = () => (state.hostBase ? { url: state.hostBase, token: state.token } : null)

  log.write('info', `apply() начат, протокол ${PROTOCOL_VERSION}, язык ${language}, журнал ${log.file}`)

  /**
   * Зарегистрировать вставку настроек в index.html, повторяя попытки.
   *
   * Вставка нужна как быстрый путь: страница получает адрес моста и токен ещё
   * до загрузки приложения. Веб-сервер может быть ещё не готов в момент
   * apply(), а при горячей перезагрузке вставка снимается вместе с прошлым
   * экземпляром плагина — поэтому здесь несколько попыток, а не одна.
   *
   * Если вставка так и не удалась, ничего не ломается: клиент умеет сам
   * забрать токен через /bootstrap.
   * @returns true, если вставка зарегистрирована.
   */
  async function ensureInjection() {
    if (state.inject) return true
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const dispose = injectBootstrap(ctx, BASE_PATH, state.token, log)
        if (dispose) {
          state.inject = dispose
          return true
        }
      } catch (error) {
        log.write('warn', `вставка в index.html: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
      await sleep(150)
    }
    log.write('warn', 'вставка в index.html недоступна: клиент возьмёт токен через /bootstrap')
    return false
  }

  // Сначала синхронная попытка (веб-сервер обычно уже готов), затем — в фоне.
  try {
    const dispose = injectBootstrap(ctx, BASE_PATH, state.token, log)
    if (dispose) state.inject = dispose
  } catch (error) {
    log.write('warn', `вставка в index.html: ${error instanceof Error ? error.message : String(error)}`)
  }

  void (async () => {
    // Вставка не зависит от транспорта: она нужна и когда мост уже поднят
    // предыдущим экземпляром плагина после горячей перезагрузки.
    await ensureInjection()

    if (state.base) {
      // Транспорт уже поднят (в том числе предыдущей версией плагина после
      // горячей перезагрузки): досчитываем абсолютный адрес и не поднимаем второй.
      if (/^https?:\/\//i.test(state.base)) {
        state.hostBase = state.base
      } else {
        const webServer = webServerOf(ctx)
        if (webServer && typeof webServer.getOrigin === 'function') {
          try {
            state.hostBase = `${webServer.getOrigin().replace(/\/$/, '')}${state.base}`
          } catch {
            state.hostBase = null
          }
        }
      }
      if (state.hostBase) {
        log.write('info', `транспорт уже поднят: ${state.hostBase}`)
        return
      }
      state.base = null
    }
    try {
      const transport = await startTransport(ctx, bridge, config, log, state.token)
      state.base = transport.base
      state.hostBase = transport.hostBase
      state.dispose = transport.dispose
      // Для собственного сервера адрес в index.html другой: клиент должен
      // знать полный URL, а не путь. Для встроенного веб-сервера вставка уже
      // сделана синхронно выше с путём, который клиент дополнит origin'ом.
      if (!state.inject) {
        const dispose = injectBootstrap(ctx, transport.base, state.token, log)
        if (dispose) state.inject = dispose
      }
      log.write('info', `мост готов: ${transport.hostBase}`)
    } catch (error) {
      state.base = null
      state.hostBase = null
      log.write('warn', `транспорт не поднялся: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  const tools = createTools(bridge, config, log, getBase, t)
  for (const definition of tools) {
    ctx.tools.register({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => text(value),
      },
      execute: async (args, exec) => definition.run(args || {}, exec),
    })
  }
  log.write('info', `зарегистрировано инструментов: ${tools.length}`)

  // Сторож загрузки: если клиентская половина не вышла на связь, значит окно
  // открыто со сборкой, где плагина ещё не было. Пишем это в журнал один раз,
  // чтобы причина была видна сразу, а не выяснялась перебором.
  setTimeout(() => {
    void (async () => {
      try {
        const base = getBase()
        if (!base) return
        const response = await fetch(`${base.url}/health`, {
          headers: base.token ? { 'x-agent-browser-token': base.token } : {},
          signal: AbortSignal.timeout(3000),
        })
        const health = await response.json()
        if (!health.clients) {
          log.write(
            'warn',
            'клиентская половина не загружена в окне: нажмите Ctrl+R, при неудаче перезапустите DeepSeek Harness',
          )
        } else {
          log.write('info', `клиент подключён: окон ${health.clients}`)
        }
      } catch {
        /* мост ещё поднимается — не мешаем */
      }
    })()
  }, 20000).unref?.()

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        try {
          state.inject?.()
        } catch {
          /* вставка уже снята */
        }
        // Обнуляем: иначе следующий apply() решит, что вставка уже сделана,
        // и после горячей перезагрузки index.html останется без настроек.
        state.inject = null
        try {
          state.dispose?.()
        } catch {
          /* транспорт уже закрыт */
        }
        state.base = null
        state.hostBase = null
        log.write('info', 'транспорт снят')
      },
      'agent-browser.transport',
    )
  }
}
