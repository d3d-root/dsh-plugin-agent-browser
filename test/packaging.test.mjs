// Тест упаковки: всё, что нужно для работы, попадает в пакет.
//
// npm публикует только файлы из `files`. Если модуль забыть, плагин у
// пользователя упадёт на импорте — а локально всё работает, потому что файл
// лежит рядом. Проверяем по факту: каждый относительный импорт из lib/ должен
// быть указан в `files`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Все относительные импорты в файле. */
function relativeImports(file) {
  const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
  const found = []
  for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) found.push(match[1])
  return found
}

test('каждый модуль lib/ указан в files', () => {
  const missing = []
  for (const entry of manifest.files.filter((f) => f.startsWith('lib/'))) {
    // Уже в списке — проверять нечего, но соберём фактические импорты.
    const imports = relativeImports(entry)
    for (const spec of imports) {
      const name = spec.replace(/^\.\//, '')
      if (name.endsWith('.mjs') || name.endsWith('.js')) {
        const asFile = `lib/${name}`
        if (!manifest.files.includes(asFile)) missing.push(`${entry} → ${asFile}`)
      }
    }
  }
  assert.deepEqual(missing, [], `не попадут в пакет: ${missing.join(', ')}`)
})

test('main и exports указывают на существующие файлы', () => {
  // `files` пишут без префикса `./`, а `exports` — с ним: нормализуем.
  const strip = (path) => String(path).replace(/^\.\//, '')
  assert.ok(manifest.files.includes(strip(manifest.main)), `main ${manifest.main} не в files`)
  for (const [key, target] of Object.entries(manifest.exports)) {
    if (key === './package.json') continue
    assert.ok(manifest.files.includes(strip(target)), `exports["${key}"] = ${target} не в files`)
  }
})

test('патч бандла и клиентская половина на месте', () => {
  assert.ok(manifest.files.includes(manifest.dsh.bundle.patch.replace(/^\.\//, '')))
  assert.ok(manifest.files.includes('lib/client.js'))
})
