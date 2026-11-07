# Задачи разработки

Файл нужен, чтобы работа не терялась при обрыве контекста: новый агент читает
его и продолжает, не перечитывая историю чата.

## Как тестировать

Репозиторий подключён к профилю junction-ом:

```
%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-plugin-agent-browser
  → C:\Users\magnes1um\Desktop\настройщик дсх\dsh-plugin-agent-browser
```

Правки в `lib/*` видны после перезапуска DSH. Ничего переустанавливать не надо.

Проверка версии: `browser_status` → строка «Версия плагина».

Публикация для внешних тестеров — тегом `next`, стабильная `latest` не трогается:

```powershell
git tag v1.1.0-dev.2; git push origin v1.1.0-dev.2   # workflow публикует с тегом next
```

## Сделано в 1.1.0-dev.1

- [x] `browser_upload` — прикрепить файлы в `input[type=file]` через DataTransfer
- [x] `browser_download` — обход блокировки скачиваний DSH: fetch в странице → base64 → хост пишет файл
- [x] `browser_extract` — массив объектов по CSS-селекторам
- [x] `browser_find_all` + `browser_click_index` — пронумерованные элементы
- [x] `browser_pdf` — печать страницы в PDF
- [x] `browser_zoom` — масштаб
- [x] `browser_find_in_page` — поиск по тексту как Ctrl+F
- [x] `browser_save_session` / `browser_restore_session` — cookie и storage переживают перезапуск
- [x] `browser_page_state` — диагностика страницы
- [x] `browser_screenshot { fullPage: true }` — вся страница

## Осталось

### 1. Несколько вкладок с адресацией по tabId

Сейчас `multiple: true`, но команды идут в видимую вкладку.

- [ ] Добавить необязательный `tabId` во все инструменты
- [ ] `browser_tabs` показывает id
- [ ] `browser_open { tabId }` создаёт именованную вкладку
- [ ] Маршрутизация в мосте: `call()` ищет панель по tabId, а не по «видимой»

Файлы: `lib/bridge.mjs` (выбор панели), `lib/index.js` (параметры), `lib/client.js` (регистрация).

### 2. Трассировка

- [ ] Настройка `trace: true`
- [ ] Писать JSONL: команда, ответ, время, сессия — в каталог чата
- [ ] Инструмент `browser_trace` — показать последние записи

Файлы: `lib/index.js` (обёртка вокруг `call`).

### 3. Английский язык

- [ ] Описания инструментов — английские (сейчас русские)
- [ ] Тексты ошибок — через словарь `MESSAGES` (уже есть ru/en, но покрывает не всё)
- [ ] README на английском как основной, русский — `README.ru.md`

Файлы: `lib/index.js`, `README.md`.

### 4. CI на каждый push

- [ ] `.github/workflows/ci.yml`: тесты + `node --check` на push и PR
- [ ] Не публиковать, только проверять

### 5. Тесты клиентской половины

- [ ] Вынести чистые функции из `client.js` в `lib/page-helpers.mjs`
- [ ] Покрыть: разбор URL, поиск по тексту, траектория перетаскивания, сборка extract-кода
- [ ] Расширить `test/bridge.test.mjs` тестами новых маршрутов `/storage/*`

### 6. Разбить client.js

1364 строки в одном файле.

- [ ] `lib/client/panel.js` — панель и webview
- [ ] `lib/client/bridge.js` — связь с мостом
- [ ] `lib/client/actions.js` — действия на странице
- [ ] `lib/client/captcha.js` — события мыши и траектории

### 7. Автосохранение входа

Сейчас `browser_save_session` вызывается вручную.

- [ ] Сохранять автоматически перед уходом со страницы
- [ ] Восстанавливать автоматически после загрузки, если для origin есть запись
- [ ] Настройка `autoSession: true`

Файлы: `lib/client.js` (`navigateTo`, инициализация панели).

### 8. История переходов

- [ ] `browser_history` — куда ходили в этом чате

## Что нельзя сделать в плагине

Ограничения DSH, не наши:

- **Постоянный профиль Chromium.** `browser.acquire()` выдаёт
  `dsh-sidebar-browser-<uuid>` без префикса `persist:`, поэтому cookie живут
  только в памяти процесса. Обходим сохранением состояния в файл (сделано).
- **Прокси.** `session.setProxy` доступен только в main-процессе.
- **Блокировка рекламы.** `webRequest` тоже только в main.

Если это нужно по-настоящему — писать в DSH, а не в плагин.
