// Серверная половина плагина «Браузер агента».
//
// Регистрирует инструменты, которыми агент управляет браузером в правой
// панели, и поднимает мост между инструментами и панелями.
//
// Ключевое отличие от «одного общего браузера»: каждая панель принадлежит
// сессии, а инструмент знает сессию своего агента (`exec.agent.id`). Поэтому
// команда всегда уходит в браузер той сессии, где работает агент, — даже если
// одновременно работают несколько агентов в разных чатах.

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBridge, PROTOCOL_VERSION, readJsonBody, startLoopbackTransport } from './bridge.mjs'
import { fetchFromHost } from './download.mjs'

export const name = 'agent-browser'
export const inject = ['tools']

/**
 * Версия плагина из его же package.json.
 *
 * Нужна в диагностике: у плагинов, поставленных из Git, кнопки обновления в
 * интерфейсе нет, поэтому «какая версия у меня стоит» — первый вопрос при
 * разборе проблем. Ошибку чтения гасим: версия не стоит падения плагина.
 */
const PLUGIN_VERSION = (() => {
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : 'неизвестно'
  } catch {
    return 'неизвестно'
  }
})()

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
  /** Писать ли в журнал каждую команду с её длительностью (для разбора «не работает»). */
  trace: false,
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

/** Предел размера файла, который можно отправить в форму на сайте. */
const UPLOAD_MAX_BYTES = 32 * 1024 * 1024

/** Предел размера скачанного файла. */
const DOWNLOAD_MAX_BYTES = 64 * 1024 * 1024

/**
 * Вкладка, выбранная текущим вызовом инструмента.
 *
 * Инструменты вызываются параллельно (два агента в двух чатах, или один агент
 * делает несколько вызовов сразу), поэтому «глобальная переменная с текущей
 * вкладкой» здесь не годится: значения перепутаются. AsyncLocalStorage хранит
 * контекст на цепочку асинхронных вызовов, и каждая команда видит свою вкладку.
 */
const tabContext = new AsyncLocalStorage()

/**
 * Кольцевой буфер последних команд.
 *
 * Когда у пользователя «не работает», журнал из строк не помогает: нужно
 * видеть, какая команда ушла, сколько ждала и чем кончилась. Буфер в памяти
 * дешёвый и не требует настройки; файл включается отдельно (`trace`).
 */
const traceBuffer = []
const TRACE_LIMIT = 300

/** Расширение → MIME-тип для загружаемых файлов. */
const MIME_BY_EXT = {  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
}

/**
 * Файл с сохранённым состоянием входа.
 *
 * Профиль Chromium внутри DSH живёт только в памяти процесса: после
 * перезапуска приложения cookie и localStorage теряются, и агент видит
 * разлогиненный сайт. Мы снимаем это состояние со страницы и держим в файле
 * рядом с плагином — тогда вход переживает перезапуск.
 */
const STORAGE_FILE = join(dirname(fileURLToPath(new URL('../package.json', import.meta.url))), '.session-store.json')

/**
 * Хранилище состояния входа на диске.
 *
 * Формат: `{ "<origin>": { cookie, local, session, at } }`. Файл читается при
 * первом обращении и переписывается целиком при сохранении: объём маленький,
 * а атомарная замена через временный файл защищает от порванного JSON.
 *
 * Ошибки чтения и записи не роняют плагин: без хранилища всё работает, просто
 * вход не переживает перезапуск.
 */
const sessionStore = (() => {
  let cache = null

  const load = () => {
    if (cache) return cache
    try {
      const raw = readFileSync(STORAGE_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      cache = parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      cache = {}
    }
    return cache
  }

  const flush = () => {
    try {
      const tmp = `${STORAGE_FILE}.tmp`
      writeFileSync(tmp, JSON.stringify(cache, null, 1), 'utf8')
      renameSync(tmp, STORAGE_FILE)
    } catch {
      /* диск недоступен — работаем из памяти */
    }
  }

  return {
    save(origin, data) {
      const store = load()
      store[origin] = { ...data, at: new Date().toISOString() }
      flush()
    },
    get(origin) {
      const store = load()
      const entry = store[origin]
      return entry && typeof entry === 'object' ? entry : null
    },
    clear() {
      cache = {}
      flush()
    },
  }
})()

/**
 * Прочитать файл для загрузки на сайт.
 *
 * Как и запись скриншотов, чтение ограничено рабочим каталогом сессии: иначе
 * агент смог бы отправить на внешний сайт любой файл с диска.
 * @param raw - путь, который передал агент.
 * @param exec - контекст вызова (нужен рабочий каталог).
 * @returns имя файла, MIME-тип и содержимое в base64.
 * @throws ToolError, когда путь вне разрешённой папки или файл слишком велик.
 */
function readUploadFile(raw, exec) {
  const target = resolve(raw)
  const root = resolve(workspaceOf(exec))
  if (target !== root && !target.startsWith(root + sep)) {
    throw new ToolError(
      'path-not-allowed',
      `загружать можно только файлы из рабочего каталога сессии (${root}), а не ${target}`,
    )
  }
  const stat = statSync(target)
  if (!stat.isFile()) throw new ToolError('not-a-file', `это не файл: ${target}`)
  if (stat.size > UPLOAD_MAX_BYTES) {
    throw new ToolError('too-large', `файл больше ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)} МБ: ${target}`)
  }
  const name = basename(target)
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : ''
  return {
    name,
    mime: MIME_BY_EXT[ext] || 'application/octet-stream',
    base64: readFileSync(target).toString('base64'),
  }
}

/**
 * Разобрать JSON, который вернула страница.
 *
 * Клиентская половина отдаёт результат строкой (так его безопаснее передавать
 * через мост), а инструментам нужен объект. Битый или пустой ответ — не
 * исключение: возвращаем null, и вызывающий сам решает, что сказать агенту.
 * @param raw - строка или уже готовый объект.
 * @returns объект, либо null.
 */
function parseJson(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw !== 'string' || !raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

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
  // Относительный путь считается от рабочего каталога сессии, а не от
  // process.cwd() процесса DSH: иначе `shot.png` уезжал в каталог профиля
  // (~/.dsh/profiles/desktop), хотя пользователь ждёт файл в папке чата.
  const target = resolve(workspaceOf(exec), raw)
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
 * показывает баннер.
 *
 * Перезагрузка страницы помогает не всегда: Electron кэширует сборку, и
 * `location.reload()` может отдать тот же старый код. Поэтому главный совет в
 * подсказке — полный перезапуск приложения, а кнопка перезагрузки окна
 * остаётся как первая, более быстрая попытка.
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
        body.textContent = 'Плагин включён, но окно открыто со старой сборкой. Закройте DeepSeek Harness и запустите заново — после этого браузер заработает.';
        text.appendChild(head);
        text.appendChild(body);
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Перезагрузить';
        button.title = 'Быстрая попытка. Если не поможет — перезапустите приложение целиком.';
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

  /**
   * Команда браузеру этой сессии.
   *
   * `tabId` позволяет адресовать конкретную вкладку, когда в чате их
   * несколько. Без него команда уходит в видимую — это поведение по умолчанию
   * и то, что ожидает агент, когда вкладка одна.
   * @param command - команда клиентской половине.
   * @param exec - контекст вызова инструмента.
   * @param options - `timeoutMs` и `tabId`.
   * @returns результат команды.
   */
  async function call(command, exec, options = {}) {
    const sessionId = await ensurePanel(exec)
    const body = { ...command, sessionId }
    const tabId = options.tabId || tabContext.getStore()
    if (tabId) body.tab = tabId
    const startedAt = Date.now()
    let ok = true
    let error
    try {
      const data = await request('/cmd', {
        method: 'POST',
        body,
        exec,
        timeoutMs: options.timeoutMs,
      })
      if (!data.ok) {
        ok = false
        error = data.error || 'команда не выполнена'
        throw new ToolError(data.code || 'command-failed', error)
      }
      return data.result || {}
    } catch (e) {
      ok = false
      error = error || String(e && e.message ? e.message : e)
      throw e
    } finally {
      const entry = {
        at: new Date().toISOString(),
        type: String(command.type || '?'),
        session: shortSession(sessionId),
        tab: tabId || '',
        ms: Date.now() - startedAt,
        ok,
        error,
      }
      traceBuffer.push(entry)
      if (traceBuffer.length > TRACE_LIMIT) traceBuffer.shift()
      if (config.trace) log.write(ok ? 'info' : 'warn', `trace ${entry.type} ${entry.ms}мс${error ? ` — ${error}` : ''}`)
    }
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

  const tools = [
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
          // id вкладки — единственный способ адресовать команду конкретной
          // вкладке через параметр tabId, поэтому он должен быть виден здесь.
          const id = panel.tabId ? ` [${panel.tabId}]` : ''
          return `${index + 1}.${id} сессия ${shortSession(panel.sessionId)} — ${where}${mine}, активна ${idle} с назад`
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
            `Версия плагина: ${PLUGIN_VERSION}\n` +
            `Проверьте журнал: ${log.file}\n` +
            'Если в нём «транспорт не поднялся» — перезапустите DeepSeek Harness.'
          )
        }
        if (!health.clients) {
          return (
            'Плагин загружен наполовину: серверная часть работает, а клиентская в окне — нет.\n' +
            'Это бывает, когда плагин включили уже после запуска приложения.\n\n' +
            'Что сделать: закройте DeepSeek Harness и запустите заново. Перезагрузка окна (Ctrl+R) помогает не всегда: Electron может отдать ту же закэшированную сборку.\n' +
            `Версия плагина: ${PLUGIN_VERSION}, протокола: ${health.version}, панелей: ${health.panels}, окон: ${health.clients}`
          )
        }
        const info = await call({ type: 'url' }, exec)
        return (
          `Встроенный браузер доступен.\nВкладка: ${info.panel || '(не указана)'}\n` +
          `URL: ${info.url}\nЗаголовок: ${info.title || '(без заголовка)'}\n` +
          `Версия плагина: ${PLUGIN_VERSION}`
        )
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
        // Клиент кладёт ответ в `value`: раньше здесь читался `result.found`,
        // которого нет, и инструмент всегда отвечал «не появилось».
        const value = result.value || {}
        const what = selector ? `селектор ${selector}` : `текст «${needle}»`
        if (value.found === true) return `Дождались за ${value.waitedMs ?? 0} мс: ${what}`
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
        fullPage: { type: 'boolean', description: 'Capture the whole page, not just the visible part' },
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
        const shot = { type: 'screenshot', rect, fullPage: args.fullPage === true }
        let result = await call(shot, exec, { timeoutMs: 90_000 })
        let dataUrl = String(result.dataUrl || '')
        // Вкладка могла только что выйти на экран (browser_reveal): Chromium
        // ещё не успел её отрисовать, и первый снимок пустой. Пара повторов с
        // паузой снимает этот случай — иначе агент делает лишний круг
        // «reveal → screenshot → reveal → screenshot».
        for (let attempt = 0; dataUrl.indexOf(',') < 0 && result.value && result.value.hidden && attempt < 3; attempt++) {
          await sleep(400)
          result = await call(shot, exec, { timeoutMs: 90_000 })
          dataUrl = String(result.dataUrl || '')
        }
        const comma = dataUrl.indexOf(',')
        if (comma < 0) {
          // Клиент не смог снять страницу: обычно вкладка в фоне — Chromium
          // не отрисовывает её и capturePage не отвечает.
          if (result.value && result.value.hidden) {
            throw new ToolError(
              'tab-hidden',
              'вкладка браузера не отрисована (в фоне или панель скрыта) — вызовите browser_reveal и повторите',
            )
          }
          return 'Ошибка: браузер не вернул изображение'
        }
        const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64')
        const target =
          typeof args.path === 'string' && args.path.trim()
            ? resolveShotPath(args.path.trim(), exec)
            : join(SHOT_DIR, `shot-${Date.now()}.png`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buffer)
        const where = result.fullPage
          ? `вся страница ${result.width}×${result.height}${result.truncated ? ' (обрезано по высоте)' : ''}`
          : rect
            ? `область ${rect.width}×${rect.height} при (${rect.x}, ${rect.y})`
            : t.visibleArea
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
    {
      name: 'browser_upload',
      description:
        'Attach files to a file input on the page, as if a person picked them in the file dialog. Files must live in the chat working directory.',
      parameters: {
        files: { type: 'array', required: true, description: 'Absolute paths of the files to attach' },
        selector: { type: 'string', description: 'CSS selector of input[type=file] (default: the first one)' },
      },
      run: async (args, exec) => {
        const list = Array.isArray(args.files) ? args.files : []
        if (!list.length) return 'Не указаны файлы. Передайте files: ["C:\\путь\\файл.pdf"]'
        const prepared = list.map((p) => readUploadFile(String(p), exec))
        const result = await call(
          { type: 'upload', selector: args.selector, files: prepared },
          exec,
          { timeoutMs: 60_000 },
        )
        const value = parseJson(result.value)
        if (!value || value.ok !== true) {
          return `Загрузка не удалась: ${(value && value.reason) || 'неизвестная причина'}`
        }
        const names = Array.isArray(value.names) ? value.names.join(', ') : ''
        return `Прикреплено файлов: ${value.count}${names ? ` (${names})` : ''}`
      },
    },
    {
      name: 'browser_download',
      description:
        'Download a file from the page into the chat working directory. Works even though the DSH shell blocks native downloads: the content is fetched inside the page and saved by the plugin. If the site forbids cross-origin reads, the file is fetched by the host instead.',
      parameters: {
        url: { type: 'string', required: true, description: 'File URL (absolute, or relative to the page)' },
        path: { type: 'string', description: 'Where to save (default: working directory, name from the URL)' },
      },
      run: async (args, exec) => {
        const raw = String(args.url || '').trim()
        if (!raw) return 'Не указан адрес файла.'
        const absolute = /^[a-z]+:\/\//i.test(raw)
          ? raw
          : String((await call({ type: 'eval', code: 'location.origin' }, exec)).value || '') + (raw.startsWith('/') ? raw : `/${raw}`)
        const result = await call(
          { type: 'download', url: absolute, maxBytes: DOWNLOAD_MAX_BYTES },
          exec,
          { timeoutMs: 120_000 },
        )
        const value = result.value || {}
        let buffer
        let via = 'страница'
        if (value.ok === true && String(value.base64 || '').length > 0) {
          buffer = Buffer.from(String(value.base64 || ''), 'base64')
        } else {
          // Страница не смогла прочитать файл: обычно это CORS на чужом
          // origin. У хоста (Node в процессе DSH) CORS нет, поэтому пробуем
          // оттуда. Цена — запрос без cookie браузера, поэтому первым всё же
          // идёт страница: она видит сессию пользователя.
          try {
            buffer = await fetchFromHost(absolute, DOWNLOAD_MAX_BYTES)
            via = 'хост'
          } catch (error) {
            // Показываем причину хостового отказа: она конкретнее («локальные
            // адреса», «только http и https»), а причину страницы добавляем
            // второй строкой, чтобы было видно, почему включился запасной путь.
            const hostReason = error instanceof Error ? error.message : String(error)
            const pageReason = value.reason ? `\nСтраница: ${value.reason}` : ''
            return `Скачать не удалось: ${hostReason}${pageReason}`
          }
        }
        let name = 'download.bin'
        try {
          const tail = new URL(absolute).pathname.split('/').filter(Boolean).pop()
          if (tail) name = decodeURIComponent(tail)
        } catch {
          /* адрес без имени — оставим имя по умолчанию */
        }
        const target =
          typeof args.path === 'string' && args.path.trim()
            ? resolveShotPath(args.path.trim(), exec)
            : join(workspaceOf(exec), name)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buffer)
        const note = via === 'хост' ? '\nИсточник: хост (страница не смогла прочитать файл из-за CORS)' : ''
        return `Скачано: ${target}\nБайт: ${buffer.length}${value.mime ? `, тип ${value.mime}` : ''}${note}`
      },
    },
    {
      name: 'browser_extract',
      description:
        'Extract structured data from the page: an array of objects taken by CSS selectors. Far cheaper than reading the whole page text when you need a table or a list of cards.',
      parameters: {
        selector: { type: 'string', required: true, description: 'CSS selector of the repeating row or card' },
        fields: {
          type: 'object',
          required: true,
          description:
            'Field name → selector inside the row. "" reads the row text, "@href" reads an attribute of the row, "a@href" reads an attribute of a nested element.',
        },
        limit: { type: 'integer', description: 'Maximum rows (default 50)' },
      },
      run: async (args, exec) => {
        const result = await call(
          { type: 'extract', selector: args.selector, fields: args.fields, limit: Number(args.limit) || 50 },
          exec,
          { timeoutMs: 60_000 },
        )
        const value = parseJson(result.value)
        if (!value || value.ok !== true) return `Не удалось извлечь: ${(value && value.reason) || 'неизвестная причина'}`
        if (!value.count) return `Ничего не найдено по селектору ${args.selector}. Всего узлов: ${value.total}.`
        return `Извлечено ${value.count} из ${value.total}:\n${JSON.stringify(value.items, null, 1)}`
      },
    },
    {
      name: 'browser_find_all',
      description:
        'List matching elements with numbers, then click the exact one with browser_click_index. Use this instead of guessing when several elements share the same text.',
      parameters: {
        selector: { type: 'string', description: 'CSS selector (optional)' },
        text: { type: 'string', description: 'Visible text to search for (optional)' },
        limit: { type: 'integer', description: 'Maximum items (default 30)' },
      },
      run: async (args, exec) => {
        if (!args.selector && !args.text) return 'Укажите selector или text.'
        const result = await call(
          { type: 'findAll', selector: args.selector, text: args.text, limit: Number(args.limit) || 30 },
          exec,
          { timeoutMs: 45_000 },
        )
        const value = parseJson(result.value)
        if (!value || value.ok !== true) return `Поиск не удался: ${(value && value.reason) || 'неизвестная причина'}`
        if (!value.shown) return `Ничего не найдено. Всего подходящих узлов: ${value.total}.`
        const lines = value.items.map(
          (it) => `[${it.index}] <${it.tag}> ${it.text || '(без текста)'}${it.href ? ` → ${it.href.slice(0, 60)}` : ''}`,
        )
        return `Найдено ${value.shown} из ${value.total}. Клик: browser_click_index { index }.\n${lines.join('\n')}`
      },
    },
    {
      name: 'browser_click_index',
      description: 'Click the element with the given number from the last browser_find_all result.',
      parameters: {
        index: { type: 'integer', required: true, description: 'Item number from browser_find_all' },
      },
      run: async (args, exec) => {
        const result = await call(
          { type: 'clickIndex', index: Number(args.index) || 0 },
          exec,
          { timeoutMs: 45_000 },
        )
        const value = parseJson(result.value)
        if (!value || value.ok !== true) return `Клик не удался: ${(value && value.reason) || 'неизвестная причина'}`
        await sleep(200)
        return `Клик по [${value.index}] «${value.text}» в (${value.x}, ${value.y})`
      },
    },
    {
      name: 'browser_pdf',
      description: 'Save the current page as a PDF file into the chat working directory.',
      parameters: {
        path: { type: 'string', description: 'Where to save (default: working directory)' },
        landscape: { type: 'boolean', description: 'Landscape orientation' },
        printBackground: { type: 'boolean', description: 'Print background graphics (default yes)' },
      },
      run: async (args, exec) => {
        const result = await call(
          { type: 'pdf', landscape: args.landscape === true, printBackground: args.printBackground !== false },
          exec,
          { timeoutMs: 120_000 },
        )
        if (!result.pdfBase64) return 'Не удалось получить PDF: браузер не поддерживает печать.'
        const buffer = Buffer.from(String(result.pdfBase64), 'base64')
        const target =
          typeof args.path === 'string' && args.path.trim()
            ? resolveShotPath(args.path.trim(), exec)
            : join(workspaceOf(exec), `page-${Date.now()}.pdf`)
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, buffer)
        return `PDF сохранён: ${target}\nБайт: ${buffer.length}`
      },
    },
    {
      name: 'browser_zoom',
      description: 'Set the page zoom factor. Useful when a site does not fit into the narrow sidebar.',
      parameters: {
        factor: { type: 'number', required: true, description: 'Zoom factor: 0.5 = half, 1 = normal, 2 = double' },
      },
      run: async (args, exec) => {
        const factor = Math.min(4, Math.max(0.25, Number(args.factor) || 1))
        await call({ type: 'zoom', factor }, exec)
        return `Масштаб: ${Math.round(factor * 100)}%`
      },
    },
    {
      name: 'browser_find_in_page',
      description: 'Search the page text and highlight matches, like Ctrl+F.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to find' },
        backward: { type: 'boolean', description: 'Search backwards' },
        findNext: { type: 'boolean', description: 'Go to the next match of the same query' },
      },
      run: async (args, exec) => {
        const result = await call(
          { type: 'findInPage', text: args.text, backward: args.backward === true, findNext: args.findNext === true },
          exec,
          { timeoutMs: 30_000 },
        )
        const value = result.value || {}
        if (value.ok !== true) return `Поиск не удался: ${value.reason || 'неизвестная причина'}`
        if (!value.matches) return `«${value.text}» не найдено на странице.`
        return `«${value.text}»: совпадений ${value.matches}, активно ${value.active}`
      },
    },
    {
      name: 'browser_save_session',
      description:
        'Save the current site login (cookies and localStorage) so it survives a DSH restart. The Chromium profile itself is not persisted by the shell, this fills that gap.',
      parameters: {},
      run: async (args, exec) => {
        const result = await call({ type: 'storageSave' }, exec, { timeoutMs: 30_000 })
        const value = result.value || {}
        if (!value.origin) return 'Не удалось определить origin страницы.'
        bridge.storage?.save?.(value.origin, {
          cookie: value.cookie || '',
          local: value.local || {},
          session: value.session || {},
        })
        const cookies = String(value.cookie || '')
          .split(';')
          .filter((p) => p.trim()).length
        return (
          `Состояние входа сохранено для ${value.origin}\n` +
          `Cookie: ${cookies}, localStorage: ${Object.keys(value.local || {}).length}, sessionStorage: ${Object.keys(value.session || {}).length}\n` +
          'Восстановить: browser_restore_session'
        )
      },
    },
    {
      name: 'browser_restore_session',
      description: 'Restore a previously saved login for the current site.',
      parameters: {},
      run: async (args, exec) => {
        const origin = String((await call({ type: 'eval', code: 'location.origin' }, exec)).value || '')
        if (!origin || origin === 'null') return 'Страница без origin (about:blank) — откройте сайт.'
        const data = bridge.storage?.get?.(origin) || null
        if (!data) return `Для ${origin} сохранённого входа нет. Сначала browser_save_session.`
        const result = await call({ type: 'storageRestore', data }, exec, { timeoutMs: 30_000 })
        const value = result.value || {}
        return (
          `Вход восстановлен для ${origin}\n` +
          `Cookie: ${value.cookie || 0}, localStorage: ${value.local || 0}, sessionStorage: ${value.session || 0}\n` +
          'Обновите страницу, если сайт не подхватил состояние: browser_reload'
        )
      },
    },
    {
      name: 'browser_page_state',
      description: 'Quick page diagnostics: origin, ready state, cookies, storage size, scroll position.',
      parameters: {},
      run: async (args, exec) => {
        const result = await call({ type: 'pageState' }, exec, { timeoutMs: 30_000 })
        const value = result.value || {}
        return (
          `URL: ${value.url}\nOrigin: ${value.origin}\nЗаголовок: ${value.title || '(без заголовка)'}\n` +
          `Готовность: ${value.ready}\nCookie: ${value.cookies} символов, localStorage: ${value.localKeys} ключей\n` +
          `Прокрутка: ${value.scrollY} из ${value.scrollHeight} (видно ${value.viewport})`
        )
      },
    },
    {
      name: 'browser_storage_clear',
      description: 'Forget all saved site logins kept by the plugin (cookies and localStorage of every site).',
      parameters: {},
      run: async () => {
        bridge.storage?.clear?.()
        return 'Сохранённые входы удалены. Профили Chromium не тронуты.'
      },
    },
    {
      name: 'browser_trace',
      description: 'Show recent browser commands of this plugin with timings — for diagnosing "it does not work".',
      parameters: {
        limit: { type: 'integer', description: 'How many entries (default 20)' },
      },
      run: async (args) => {
        const limit = Math.min(200, Math.max(1, Number(args.limit) || 20))
        const entries = traceBuffer.slice(-limit)
        if (!entries.length) return 'Записей нет. Включите trace: true в настройках плагина.'
        const lines = entries.map(
          (e) => `${e.at} ${e.ok ? 'ok' : 'ERR'} ${e.type} ${e.ms}мс${e.error ? ` — ${e.error}` : ''}`,
        )
        return `Последние ${entries.length} команд:\n${lines.join('\n')}`
      },
    },
  ]

  // Адресация вкладки.
  //
  // В чате может быть несколько вкладок «Браузер агента». Чтобы не добавлять
  // параметр `tabId` вручную в тридцать с лишним инструментов (и не забыть
  // где-нибудь), он добавляется всем сразу, а значение едет в AsyncLocalStorage:
  // так оно не путается между параллельными вызовами разных агентов.
  for (const tool of tools) {
    if (!tool.parameters) tool.parameters = {}
    if (!tool.parameters.tabId) {
      tool.parameters.tabId = {
        type: 'string',
        description: 'Tab id from browser_tabs (optional; default: the visible tab of this chat)',
      }
    }
    const original = tool.run
    tool.run = (args, exec) => {
      const tabId = args && typeof args.tabId === 'string' && args.tabId.trim() ? args.tabId.trim() : undefined
      return tabContext.run(tabId, () => original(args, exec))
    }
  }

  return tools
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
  const bridge = (globalThis.__dshAgentBrowserBridge ||= createBridge({
    startUrl: config.startUrl,
    storage: sessionStore,
  }))
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

  log.write(
    'info',
    `apply() начат, плагин ${PLUGIN_VERSION}, протокол ${PROTOCOL_VERSION}, язык ${language}, журнал ${log.file}`,
  )

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
            'клиентская половина не загружена в окне: закройте и запустите DeepSeek Harness заново',
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
