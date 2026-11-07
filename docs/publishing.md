# Как выложить плагин на GitHub

Репозиторий готов: осталось создать его на GitHub и запушить. После этого
плагин ставится одной ссылкой — npm не нужен.

---

## 1. Проверка перед публикацией

В репозитории не должно быть ваших путей, токенов и профилей.

```powershell
cd dsh-plugin-agent-browser

# личные пути (должно быть пусто)
Select-String -Path lib\*.js,lib\*.mjs,*.json,*.yml,docs\*.md,test\*.mjs `
  -Pattern 'C:\\Users|AppData' -AllMatches

# секреты (должно быть пусто)
Select-String -Path lib\*.js,lib\*.mjs,*.json,*.yml `
  -Pattern 'api[_-]?key|sk-|password|secret' -AllMatches

# тесты
npm test

# синтаксис
node --check lib/index.js
node --check lib/bridge.mjs
```

Оба поиска должны ничего не найти. Слово `token` в коде — это внутренний токен
моста: он генерируется при каждом запуске, никуда не сохраняется и наружу не
отдаётся (кроме страницы самого DSH).

---

## 2. Создать репозиторий

1. Откройте https://github.com/new
2. **Repository name:** `dsh-plugin-agent-browser`
3. **Public**
4. **Не** добавляйте README, .gitignore и лицензию — они уже есть.
5. Create repository.

---

## 3. Запушить

```powershell
cd dsh-plugin-agent-browser

git init
git add .
git commit -m "Браузер агента для DeepSeek Harness: свой браузер у каждого чата"
git branch -M main
git remote add origin https://github.com/d3d-root/dsh-plugin-agent-browser.git
git push -u origin main
```

`.gitignore` уже исключает `node_modules`, журналы, скриншоты и секреты.

---

## 4. Оформить репозиторий

После пуша стоит добавить то, что делает проект живым:

**Описание** (справа вверху, кнопка ⚙):

> A real browser in the DeepSeek Harness right sidebar — one per chat, driven by agent tools

**Topics** (там же):

```
dsh  dsh-plugin  dsh-bundle  deepseek-harness  browser  webview  agent
```

**Release** — создайте тег `v1.0.1`, чтобы люди видели версии. В описании
релиза можно скопировать раздел «Возможности» из README.

---

## 5. Как люди будут ставить

В DSH: **Plugins → Add plugin** → вставить

```
https://github.com/d3d-root/dsh-plugin-agent-browser
```

→ включить → **полностью перезапустить DSH**.

Это всё. Ни npm, ни Node, ни Chrome у них не нужны.

---

## 6. Чек-лист

- [ ] поиск путей и секретов — пусто
- [ ] `npm test` — все тесты проходят
- [ ] `node --check` на оба файла — без ошибок
- [ ] `author`, `repository`, `bugs`, `homepage` заполнены
- [ ] README открывается, ссылки `docs/…` не битые
- [ ] `docs/screenshot.png` на месте
- [ ] репозиторий запушен, описание и topics заданы

---

## 7. Если захотите в npm

Не обязательно, но можно: имя `dsh-plugin-agent-browser` свободно.

```powershell
npm login
npm publish
```

Тогда установка станет ещё короче — по имени пакета. Проверить, что попадёт в
архив:

```powershell
npm pack --dry-run
```

В архив попадут только файлы из `files` в `package.json` — тесты и docs туда не
входят, это нормально.

### Что это даёт, кроме короткой команды

**Кнопку «Обновить» в интерфейсе.** DSH показывает её только для пакетов,
поставленных из реестра под своим именем. При установке из GitHub кнопки нет —
обновляться приходится командой `dsh plugin add`, как описано в
[`install.md`](install.md#обновление).

Причина в проверке самого DSH (`updateRefusal`): обновление разрешено, только
если спецификация в манифесте профиля — реестровая, с именем, совпадающим с
именем пакета. `github:d3d-root/...` этому условию не отвечает, поэтому
`updatable: false`.

Если обновления «в один клик» важны — публикуйте в npm.

### Разовая настройка npm

Токены и секреты GitHub для этого **не нужны**: публикация идёт по OIDC
(Trusted Publishing). GitHub выдаёт короткоживущий токен на один запуск
workflow, npm проверяет его по настроенному доверенному издателю. Хранить
нечего — утекать нечему.

Порядок важен: сначала ручная публикация, потом настройка издателя. Настроить
доверенного издателя **до** первой публикации нельзя — пакета на npm ещё нет,
и страницы настроек у него тоже нет.

#### Шаг 1. Подтвердите почту и включите 2FA

https://www.npmjs.com/settings → **Account**. Без подтверждённой почты npm не
даст опубликовать пакет.

**2FA обязательна.** С июля 2026 npm требует интерактивное подтверждение при
прямой публикации, а токены с обходом 2FA больше не могут публиковать пакеты
([changelog](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)).
Без включённой 2FA `npm publish` отвечает:

```
E403 403 Forbidden - Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages.
```

Включение: https://www.npmjs.com/settings → **Two-Factor Authentication** →
**Enable 2FA** → **Authenticator app** → отсканируйте QR-код приложением
(Google Authenticator, Authy, 1Password, Aegis) → введите код.

**Сохраните коды восстановления**, которые покажет npm. Без них потеря
телефона означает потерю доступа к аккаунту.

#### Шаг 2. Первая публикация — вручную

```powershell
cd dsh-plugin-agent-browser
& "C:\Program Files\nodejs\npm.cmd" login                # один раз, откроется браузер
& "C:\Program Files\nodejs\npm.cmd" pack --dry-run       # что попадёт в архив

# код из приложения-аутентификатора, живёт 30 секунд
& "C:\Program Files\nodejs\npm.cmd" publish --access public --otp=123456
```

Без `--otp` npm спросит код отдельным вопросом — тоже рабочий вариант.

**Это единственный раз, когда нужен код.** Дальше публикует GitHub Actions по
OIDC, а он 2FA не требует.

#### Шаг 3. Настройте доверенного издателя

https://www.npmjs.com/package/dsh-plugin-agent-browser → **Settings** →
**Trusted Publisher** → **GitHub Actions**:

| Поле | Значение |
|---|---|
| Organization or user | `d3d-root` |
| Repository | `dsh-plugin-agent-browser` |
| Workflow filename | `publish.yml` |
| Environment | оставить пустым |

#### Шаг 4. Запретите публикацию по токенам

Там же, в **Settings → Publishing access**: выберите вариант, при котором
публиковать можно **только** через доверенного издателя. Тогда даже украденный
токен не даст выпустить версию от вашего имени.

### Дальше — автоматически по тегу

```powershell
# 1) поднять версию в package.json и дописать раздел в CHANGELOG.md
# 2) закоммитить и запушить
git add -A; git commit -m "1.0.3: …"; git push
# 3) поставить тег — workflow сам проверит тесты и опубликует
git tag v1.0.3; git push origin v1.0.3
```

Workflow сверит тег с версией в `package.json`, прогонит тесты и вызовет
`npm publish --provenance`. Если версия не совпала с тегом — упадёт до
публикации, а не после.

Дальше у пользователей появится кнопка обновления.

### Почему не NPM_TOKEN в секретах GitHub

Можно и так — секреты GitHub зашифрованы и их значение после сохранения не
может прочитать даже владелец репозитория. Но у токена есть срок жизни и права
на **все** ваши пакеты, а у OIDC-подхода — нет ни того, ни другого: он
действует минуты и только для этого репозитория и этого файла workflow.

Если всё же нужен токен — берите **Granular**, а не Automation: в нём можно
выдать права только на один пакет.
