// Запасное скачивание силами хоста.
//
// Зачем модуль отдельно: у процесса DSH нет CORS, поэтому он может забрать
// файл с чужого origin, где страница бессильна. Логика маленькая, но
// чувствительная (сеть, размеры, запрет локальных адресов), поэтому она
// вынесена из index.js и покрыта тестами — в том числе с подменённым fetch,
// чтобы проверка не зависела от интернета в CI.

/** Ошибка скачивания с машинным кодом. */
export class DownloadError extends Error {
  /**
   * @param code - машинный код (`private-host`, `too-large`, …).
   * @param message - текст для человека.
   */
  constructor(code, message) {
    super(message)
    this.name = 'DownloadError'
    this.code = code
  }
}

/**
 * Приватный ли адрес: loopback, локальная сеть, link-local.
 *
 * Хостовый `fetch` идёт из процесса DSH и CORS не подчиняется — значит, он же
 * обходит и запрет `<webview>` ходить на служебные адреса. Без этой проверки
 * агент мог бы через `browser_download` достучаться до сервисов на
 * `127.0.0.1` (в том числе до собственного веб-сервера DSH) и вытащить ответ
 * файлом. Поэтому такие адреса хостовым путём запрещены: если файл нужен с
 * локального сайта, его спокойно заберёт сама страница (свой origin).
 * @param hostname - имя хоста из URL.
 * @returns true, если адрес локальный.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
  if (!host) return true
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host === '::' || host === '0.0.0.0') return true
  // IPv6 link-local и unique-local.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  if (a === 127 || a === 10 || a === 0) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  return false
}

/** Предел по умолчанию, если вызывающий не задал свой. */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/**
 * Забрать файл силами хоста — когда страница не смогла из-за CORS.
 *
 * У процесса DSH нет CORS, поэтому чужой origin здесь читается. Обратная
 * сторона: запрос идёт без cookie браузера, поэтому страница всегда
 * пробуется первой, а этот путь — запасной.
 * @param url - абсолютный адрес файла.
 * @param options - `maxBytes` (предел размера), `timeoutMs`, `fetchImpl`.
 * @returns содержимое файла.
 * @throws DownloadError, если адрес локальный, ответ не 2xx или файл слишком велик.
 */
export async function fetchFromHost(url, options = {}) {
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 60_000
  const doFetch = options.fetchImpl || fetch

  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new DownloadError('bad-url', `не разобрать адрес: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new DownloadError('bad-scheme', `поддерживаются только http и https, а не ${parsed.protocol}`)
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new DownloadError(
      'private-host',
      `хостовый путь не ходит на локальные адреса (${parsed.hostname}) — файл должен забрать сам браузер`,
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await doFetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        // Многие CDN отдают 403 без внятного User-Agent.
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        accept: '*/*',
      },
    })
    if (!response.ok) {
      throw new DownloadError('http-status', `сервер ответил ${response.status}`)
    }
    // Размер проверяем дважды: по заголовку (дешево, до чтения тела) и по
    // факту — заголовку Content-Length сервер может и соврать.
    const declared = Number(response.headers.get('content-length') || 0)
    if (declared > maxBytes) {
      throw new DownloadError('too-large', `файл ${declared} байт больше предела ${maxBytes}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > maxBytes) {
      throw new DownloadError('too-large', `файл ${buffer.length} байт больше предела ${maxBytes}`)
    }
    return buffer
  } catch (error) {
    if (error instanceof DownloadError) throw error
    const reason = controller.signal.aborted
      ? 'истекло время ожидания'
      : error instanceof Error
        ? error.message
        : String(error)
    throw new DownloadError('host-fetch', `хост не смог забрать файл: ${reason}`)
  } finally {
    clearTimeout(timer)
  }
}
