// Тесты запасного скачивания через хост.
//
// Сеть здесь не нужна: `fetchFromHost` принимает `fetchImpl`, поэтому все
// ветки проверяются подменённым fetch. Так тест не зависит от интернета —
// важно, потому что эти же тесты прогоняются перед публикацией в npm.
//
// Отдельное внимание — запрету локальных адресов: хостовый fetch обходит
// запрет webview ходить на служебные адреса, и без проверки агент мог бы
// вытащить ответ локального сервиса файлом.

import test from 'node:test'
import assert from 'node:assert/strict'
import { DownloadError, fetchFromHost, isPrivateHost } from '../lib/download.mjs'

/** Ответ-заглушка с телом и заголовками. */
function response(body, { status = 200, headers = {} } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return Object.prototype.hasOwnProperty.call(headers, name.toLowerCase())
          ? headers[name.toLowerCase()]
          : null
      },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    },
  }
}

test('isPrivateHost: loopback и локальные сети считаются приватными', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'app.localhost',
    'printer.local',
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.5',
    '192.168.1.1',
    '172.16.0.1',
    '172.31.255.255',
    '169.254.169.254',
    '::1',
    '[::1]',
    'fd00::1',
    'fe80::1',
    '',
  ]) {
    assert.equal(isPrivateHost(host), true, `должен быть приватным: ${host}`)
  }
})

test('isPrivateHost: обычные адреса считаются публичными', () => {
  for (const host of [
    'example.com',
    'ru.wikipedia.org',
    'upload.wikimedia.org',
    '8.8.8.8',
    '172.32.0.1',
    '172.15.0.1',
    '193.168.1.1',
    '11.0.0.1',
  ]) {
    assert.equal(isPrivateHost(host), false, `должен быть публичным: ${host}`)
  }
})

test('fetchFromHost отдаёт содержимое файла', async () => {
  const buffer = await fetchFromHost('https://example.com/a.txt', {
    fetchImpl: async () => response('привет'),
  })
  assert.equal(buffer.toString('utf8'), 'привет')
})

test('fetchFromHost отправляет браузерный User-Agent', async () => {
  let seen
  await fetchFromHost('https://example.com/a.txt', {
    fetchImpl: async (url, options) => {
      seen = options
      return response('ok')
    },
  })
  assert.match(seen.headers['user-agent'], /Chrome\//)
  assert.equal(seen.redirect, 'follow')
})

test('fetchFromHost не ходит на локальные адреса', async () => {
  for (const url of [
    'http://127.0.0.1:8080/secret',
    'http://localhost/secret',
    'http://192.168.0.10/secret',
    'http://[::1]/secret',
    'http://169.254.169.254/latest/meta-data',
  ]) {
    await assert.rejects(
      () => fetchFromHost(url, { fetchImpl: async () => response('нельзя') }),
      (error) => {
        assert.ok(error instanceof DownloadError, `тип ошибки для ${url}`)
        assert.equal(error.code, 'private-host', `код ошибки для ${url}`)
        assert.match(error.message, /локальные адреса/)
        return true
      },
    )
  }
})

test('fetchFromHost пропускает только http и https', async () => {
  for (const url of ['file:///C:/Windows/win.ini', 'ftp://example.com/a', 'data:text/plain,hi']) {
    await assert.rejects(
      () => fetchFromHost(url, { fetchImpl: async () => response('нельзя') }),
      (error) => {
        assert.equal(error.code, 'bad-scheme', `код ошибки для ${url}`)
        assert.match(error.message, /http и https/)
        return true
      },
    )
  }
})

test('fetchFromHost отвергает неразбираемый адрес', async () => {
  await assert.rejects(
    () => fetchFromHost('это не адрес', { fetchImpl: async () => response('x') }),
    (error) => {
      assert.equal(error.code, 'bad-url')
      return true
    },
  )
})

test('fetchFromHost сообщает HTTP-ошибку сервера', async () => {
  await assert.rejects(
    () => fetchFromHost('https://example.com/a.txt', { fetchImpl: async () => response('nope', { status: 404 }) }),
    (error) => {
      assert.equal(error.code, 'http-status')
      assert.match(error.message, /404/)
      return true
    },
  )
})

test('fetchFromHost проверяет размер по заголовку до чтения тела', async () => {
  let bodyRead = false
  const bigByHeader = {
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'content-length' ? '999999' : null) },
    async arrayBuffer() {
      bodyRead = true
      return new ArrayBuffer(0)
    },
  }
  await assert.rejects(
    () =>
      fetchFromHost('https://example.com/big.bin', {
        maxBytes: 10,
        fetchImpl: async () => bigByHeader,
      }),
    (error) => {
      assert.equal(error.code, 'too-large')
      return true
    },
  )
  assert.equal(bodyRead, false, 'тело не должно читаться, если размер известен из заголовка')
})

test('fetchFromHost проверяет фактический размер: заголовку верить нельзя', async () => {
  await assert.rejects(
    () =>
      fetchFromHost('https://example.com/big.bin', {
        maxBytes: 5,
        // Заголовок врёт, что файл маленький.
        fetchImpl: async () => response('много-много-байт', { headers: { 'content-length': '2' } }),
      }),
    (error) => {
      assert.equal(error.code, 'too-large')
      return true
    },
  )
})

test('fetchFromHost заворачивает сетевую ошибку в понятный код', async () => {
  await assert.rejects(
    () =>
      fetchFromHost('https://example.com/a.txt', {
        fetchImpl: async () => {
          throw new Error('getaddrinfo ENOTFOUND example.com')
        },
      }),
    (error) => {
      assert.equal(error.code, 'host-fetch')
      assert.match(error.message, /ENOTFOUND/)
      return true
    },
  )
})
