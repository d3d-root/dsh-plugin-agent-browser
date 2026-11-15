// Определение типа файла по содержимому.
//
// Зачем отдельным модулем: сервер не всегда присылает Content-Type, а при
// скачивании через страницу он может потеряться вовсе. Наблюдали вживую: SVG с
// Hacker News сохранился под именем `logo.png`, и файл открывался как битый —
// причина была неясна ни пользователю, ни агенту.
//
// Здесь только чистые функции без ввода-вывода, поэтому их легко проверить.

/** Расширение → MIME-тип. Используется и при загрузке файлов на страницу. */
export const MIME_BY_EXT = {
  txt: 'text/plain',
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
 * Определить MIME-тип по первым байтам файла.
 * @param buffer - содержимое файла.
 * @returns MIME-тип или пустая строка, если тип не распознан.
 */
export function sniffMime(buffer) {
  if (!buffer || buffer.length < 4) return ''
  const head = buffer.subarray(0, 16)
  const text = head.toString('latin1')
  if (head[0] === 0x89 && text.slice(1, 4) === 'PNG') return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg'
  if (text.startsWith('GIF8')) return 'image/gif'
  if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') return 'image/webp'
  if (text.startsWith('%PDF')) return 'application/pdf'
  if (head[0] === 0x50 && head[1] === 0x4b) return 'application/zip'
  // SVG и JSON — текстовые: смотрим на начало без BOM и пробелов. Окно шире
  // сигнатурного: у SVG перед тегом бывает XML-пролог `<?xml ... ?>`, и
  // шестнадцати байт для него не хватает.
  const body = buffer
    .subarray(0, 512)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase()
  if (body.startsWith('<svg') || (body.startsWith('<?xml') && body.includes('<svg'))) return 'image/svg+xml'
  if (body.startsWith('{') || body.startsWith('[')) return 'application/json'
  return ''
}

/**
 * Расширение для MIME-типа.
 * @param mime - тип.
 * @returns расширение без точки или пустая строка.
 */
export function extensionFor(mime) {
  if (!mime) return ''
  return Object.keys(MIME_BY_EXT).find((ext) => MIME_BY_EXT[ext] === mime) || ''
}

/**
 * Расширение по имени файла.
 * @param name - имя.
 * @returns расширение в нижнем регистре или пустая строка.
 */
export function extensionOf(name) {
  const dot = String(name || '').lastIndexOf('.')
  return dot > 0 ? String(name).slice(dot + 1).toLowerCase() : ''
}
