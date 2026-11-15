// Проверка кодировки файлов проекта.
//
// PowerShell при записи файла иногда перекодирует его, и русский текст
// превращается в мусор («РїР°РЅРµР»). Такой файл выглядит рабочим для Node —
// это просто другие символы, — и ошибка всплывает уже в интерфейсе или в
// ответе инструмента. Здесь она ловится до коммита.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FILES = [
  'lib/client.js',
  'lib/index.js',
  'lib/bridge.mjs',
  'lib/file-type.mjs',
  'scripts/fix-dsh-start.ps1',
  'CHANGELOG.md',
  'README.md',
  'cordis.patch.yml',
]

/** Признак двойного перекодирования: кириллица, прочитанная как Latin-1. */
const MOJIBAKE = /Р[РС][а-яА-Я]|вЂ|пїЅ/

test('файлы проекта не перекодированы', () => {
  const broken = []
  for (const file of FILES) {
    const text = readFileSync(file, 'utf8')
    if (MOJIBAKE.test(text)) broken.push(file)
  }
  assert.deepEqual(broken, [], `испорчена кодировка: ${broken.join(', ')}`)
})

test('PowerShell-скрипт сохранён с BOM', () => {
  // Windows PowerShell 5.1 читает файл без BOM как ANSI: русский текст
  // превращается в мусор, и скрипт не запускается с ошибкой разбора.
  const bytes = readFileSync('scripts/fix-dsh-start.ps1')
  assert.equal(bytes[0], 0xef, 'нет BOM: PowerShell 5.1 не прочитает файл')
  assert.equal(bytes[1], 0xbb)
  assert.equal(bytes[2], 0xbf)
})

test('русские тексты на месте', () => {
  // Если файл перекодировали и обратно, кириллица может не восстановиться:
  // проверяем, что она вообще есть там, где должна быть.
  assert.ok(readFileSync('lib/index.js', 'utf8').includes('панель'))
  assert.ok(readFileSync('lib/client.js', 'utf8').includes('вкладк'))
  assert.ok(readFileSync('cordis.patch.yml', 'utf8').includes('Стартовая'))
})
