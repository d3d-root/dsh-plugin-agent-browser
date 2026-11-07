// Тесты кода, который клиент выполняет внутри страницы.
//
// Почему отдельный файл: `lib/client.js` — это готовая сборка формата
// `window.__ModuleLoader__.load({ id, factory })`, её нельзя просто
// импортировать в Node. Но самое важное в ней — строки JavaScript, которые
// уезжают в страницу, — проверить можно и нужно: именно там жили ошибки,
// невидимые ни тестам моста, ни тестам инструментов.
//
// Здесь код извлечения берётся из исходника между маркерами
// `EXTRACT-SNIPPET-START` / `EXTRACT-SNIPPET-END` и исполняется на поддельном
// DOM. Это тот же самый код, а не его пересказ: если поменять сборщик, тест
// увидит изменение.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')

/**
 * Достать из сборки клиента функцию, собирающую код извлечения.
 *
 * Маркеры нужны, чтобы тест не зависел от отступов и окружающего кода.
 * @returns функция `(selector, fields, limit) => string`.
 */
function extractBuilder() {
  const start = SOURCE.indexOf('// EXTRACT-SNIPPET-START')
  const end = SOURCE.indexOf('// EXTRACT-SNIPPET-END')
  assert.ok(start >= 0, 'в client.js нет маркера EXTRACT-SNIPPET-START')
  assert.ok(end > start, 'в client.js нет маркера EXTRACT-SNIPPET-END')
  const body = SOURCE.slice(SOURCE.indexOf('\n', start) + 1, end)
  // Тело объявляет `var buildExtractCode = function ...` — возвращаем его.
  // eslint-disable-next-line no-new-func
  const builder = new Function(`${body}\nreturn buildExtractCode;`)()
  assert.equal(typeof builder, 'function', 'buildExtractCode не функция')
  return builder
}

/** Узел поддельного DOM с текстом, атрибутами и вложенными узлами. */
function node(text, attrs, children) {
  return {
    innerText: text,
    textContent: text,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs || {}, name) ? attrs[name] : null
    },
    querySelector(selector) {
      return (children || {})[selector] || null
    },
  }
}

/**
 * Выполнить собранный код на поддельном документе.
 * @returns разобранный ответ страницы.
 */
function runExtract(fields, rows, limit) {
  const code = extractBuilder()('.card', fields, limit)
  const fakeDocument = {
    querySelectorAll() {
      return rows
    },
  }
  // eslint-disable-next-line no-new-func
  const raw = new Function('document', `return ${code}`)(fakeDocument)
  return JSON.parse(raw)
}

const ROW = node('Кроссовки A 5000 подробнее', { class: 'card', 'data-id': '7' }, {
  '.title': node('Кроссовки A'),
  '.price': node('5000'),
  a: node('подробнее', { href: '/a' }),
})

test('extract: пустая строка отдаёт текст строки', () => {
  const parsed = runExtract({ all: '' }, [ROW])
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.items[0], { all: 'Кроссовки A 5000 подробнее' })
})

test('extract: "@attr" читает атрибут самой строки — старое поведение', () => {
  const parsed = runExtract({ cls: '@class', id: '@data-id' }, [ROW])
  assert.deepEqual(parsed.items[0], { cls: 'card', id: '7' })
})

test('extract: ".sel" читает текст вложенного узла — старое поведение', () => {
  const parsed = runExtract({ title: '.title', price: '.price' }, [ROW])
  assert.deepEqual(parsed.items[0], { title: 'Кроссовки A', price: '5000' })
})

test('extract: "sel@attr" читает атрибут вложенного узла', () => {
  const parsed = runExtract({ link: 'a@href' }, [ROW])
  assert.deepEqual(parsed.items[0], { link: '/a' })
})

test('extract: все четыре формы вместе — карточка товара одним проходом', () => {
  const parsed = runExtract({ all: '', title: '.title', price: '.price', link: 'a@href', own: '@class' }, [ROW])
  assert.deepEqual(parsed.items[0], {
    all: 'Кроссовки A 5000 подробнее',
    title: 'Кроссовки A',
    price: '5000',
    link: '/a',
    own: 'card',
  })
})

test('extract: нет вложенного узла или атрибута — пустая строка, а не падение', () => {
  const parsed = runExtract({ missing: '.nope', noAttr: 'a@data-nope', link: 'a@href' }, [ROW])
  assert.deepEqual(parsed.items[0], { missing: '', noAttr: '', link: '/a' })
})

test('extract: битый селектор поля не ломает остальные поля', () => {
  const parsed = runExtract({ bad: '<<', title: '.title' }, [ROW])
  assert.deepEqual(parsed.items[0], { bad: '', title: 'Кроссовки A' })
})

test('extract: "@" внутри квадратных скобок не считается разделителем', () => {
  // [href*="@"] — валидный CSS-селектор. Раньше наивный lastIndexOf('@')
  // принял бы «@"]» за имя атрибута и сломал селектор.
  const row = node('ссылка на почту', {}, { '[href*="@"]': node('ссылка на почту', { href: '/mail' }) })
  const parsed = runExtract({ text: '[href*="@"]', href: '[href*="@"]@href' }, [row])
  assert.deepEqual(parsed.items[0], { text: 'ссылка на почту', href: '/mail' })
})

test('extract: «селектор@атрибут» с составным селектором', () => {
  const row = node('карточка', {}, { 'a.big[data-x]': node('', { href: '/deep' }) })
  const parsed = runExtract({ link: 'a.big[data-x]@href' }, [row])
  assert.deepEqual(parsed.items[0], { link: '/deep' })
})

test('extract: хвост не похож на имя атрибута — вся строка считается селектором', () => {
  // «a@123» не может быть атрибутом: остаётся прежнее поведение — селектор
  // «a@123», которого нет, поэтому пустая строка и никакого падения.
  const parsed = runExtract({ x: 'a@123', title: '.title' }, [ROW])
  assert.deepEqual(parsed.items[0], { x: '', title: 'Кроссовки A' })
})

test('extract: пробелы схлопываются', () => {
  const messy = node('  Кроссовки \n\t B  ', {}, { '.title': node('  Кроссовки \n  B  ') })
  const parsed = runExtract({ all: '', title: '.title' }, [messy])
  assert.deepEqual(parsed.items[0], { all: 'Кроссовки B', title: 'Кроссовки B' })
})

test('extract: limit ограничивает строки, total показывает все', () => {
  const rows = [node('a'), node('b'), node('c')]
  const parsed = runExtract({ all: '' }, rows, 2)
  assert.equal(parsed.total, 3)
  assert.equal(parsed.count, 2)
})

test('extract: битый селектор строки возвращает причину', () => {
  const code = extractBuilder()('<<', { all: '' }, 5)
  const brokenDocument = {
    querySelectorAll() {
      throw new Error('SyntaxError')
    },
  }
  // eslint-disable-next-line no-new-func
  const parsed = JSON.parse(new Function('document', `return ${code}`)(brokenDocument))
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /плохой селектор/)
})

test('extract: нечисловой limit превращается в значение по умолчанию', () => {
  const code = extractBuilder()('.card', { all: '' }, undefined)
  assert.match(code, /var limit=50;/)
})
