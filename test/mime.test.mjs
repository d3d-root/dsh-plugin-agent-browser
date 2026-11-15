// Тесты определения типа скачанного файла.
//
// Сервер не всегда присылает Content-Type, а при скачивании через страницу он
// может потеряться. Наблюдали вживую: SVG с Hacker News сохранился под именем
// `logo.png` — файл открывался как битый, и причина была неясна.
import test from 'node:test'
import assert from 'node:assert/strict'
import { sniffMime, extensionFor, extensionOf, MIME_BY_EXT } from '../lib/file-type.mjs'

test('PNG узнаётся по сигнатуре', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  assert.equal(sniffMime(png), 'image/png')
})

test('JPEG узнаётся по сигнатуре', () => {
  assert.equal(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), 'image/jpeg')
})

test('PDF узнаётся по сигнатуре', () => {
  assert.equal(sniffMime(Buffer.from('%PDF-1.4\n...')), 'application/pdf')
})

test('SVG узнаётся по разметке', () => {
  assert.equal(
    sniffMime(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')),
    'image/svg+xml',
  )
  assert.equal(sniffMime(Buffer.from('<svg viewBox="0 0 1 1"></svg>')), 'image/svg+xml')
})

test('GIF и WebP узнаются', () => {
  assert.equal(sniffMime(Buffer.from('GIF89a......')), 'image/gif')
  assert.equal(sniffMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
})

test('ZIP узнаётся по PK', () => {
  assert.equal(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])), 'application/zip')
})

test('JSON узнаётся по началу', () => {
  assert.equal(sniffMime(Buffer.from('{"a":1}')), 'application/json')
  assert.equal(sniffMime(Buffer.from('[1,2,3]')), 'application/json')
})

test('неизвестное содержимое не выдумывает тип', () => {
  assert.equal(sniffMime(Buffer.from([0x01, 0x02, 0x03, 0x04])), '')
  assert.equal(sniffMime(Buffer.alloc(0)), '')
  assert.equal(sniffMime(null), '')
})

test('расширение находится по типу и наоборот', () => {
  assert.equal(extensionFor('image/png'), 'png')
  assert.equal(extensionFor('image/svg+xml'), 'svg')
  assert.equal(extensionFor('application/pdf'), 'pdf')
  assert.equal(extensionFor('нет-такого'), '')
  assert.equal(extensionOf('logo.PNG'), 'png')
  assert.equal(extensionOf('без-расширения'), '')
})

test('таблица типов покрывает основные форматы', () => {
  for (const ext of ['png', 'jpg', 'pdf', 'svg', 'zip', 'csv', 'json']) {
    assert.ok(MIME_BY_EXT[ext], `нет типа для ${ext}`)
  }
})
