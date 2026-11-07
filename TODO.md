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

Проверка: `browser_status` → строка «Версия плагина» (сейчас `1.1.0-dev.1`).

Публикация для внешних тестеров — тегом `next`, стабильная `latest` не трогается:

```powershell
git tag v1.1.0-dev.2; git push origin v1.1.0-dev.2
```

## Сделано в 1.1.0-dev.1

- [x] `browser_upload` — прикрепить файлы в `input[type=file]` через DataTransfer
- [x] `browser_download` — обход блокировки скачиваний: fetch в странице → base64 → хост пишет файл
- [x] `browser_extract` — массив объектов по CSS-селекторам
- [x] `browser_find_all` + `browser_click_index` — пронумерованные элементы
- [x] `browser_pdf` — печать страницы в PDF
- [x] `browser_zoom` — масштаб
- [x] `browser_find_in_page` — поиск по тексту как Ctrl+F
- [x] `browser_save_session` / `browser_restore_session` / `browser_storage_clear`
- [x] `browser_page_state` — диагностика страницы
- [x] `browser_screenshot { fullPage: true }` — вся страница
- [x] `tabId` во всех 35 инструментах (AsyncLocalStorage)
- [x] `browser_trace` + настройка `trace`
- [x] CI на каждый push (Ubuntu + Windows)
- [x] Тесты: 33 (мост + регистрация инструментов)

Инструментов: **35** (было 22).

## Осталось

### 1. Автосохранение входа

Сейчас `browser_save_session` вызывается вручную.

- [ ] Сохранять перед уходом со страницы (`navigateTo` — перед `loadURL`)
- [ ] Восстанавливать после загрузки, если для origin есть запись
- [ ] Настройка `autoSession: true` (по умолчанию включена)

Файлы: `lib/client.js` (`navigateTo`, инициализация панели).

### 2. История переходов

- [ ] `browser_history` — куда ходили в этом чате

Файл: `lib/client.js` (слушать `did-navigate`, копить список).

### 3. Английский язык

- [ ] Описания инструментов — английские (сейчас русские)
- [ ] Тексты ошибок — через словарь `MESSAGES` (ru/en уже есть, покрывает не всё)
- [ ] `README.md` — английский основной, русский в `README.ru.md`

### 4. Тесты клиентской половины

- [ ] Вынести чистые функции из `client.js` в `lib/page-helpers.mjs`
- [ ] Покрыть: разбор URL, поиск по тексту, траектория перетаскивания, сборка extract-кода

### 5. Разбить client.js

1439 строк в одном файле.

- [ ] `lib/client/panel.js` — панель и webview
- [ ] `lib/client/bridge.js` — связь с мостом
- [ ] `lib/client/actions.js` — действия на странице
- [ ] `lib/client/captcha.js` — события мыши и траектории

### 6. Отпечаток браузера

- [ ] `outerWidth`/`outerHeight` не нулевые (сейчас 0 — признак автоматизации)
- [ ] Задержки при вводе текста (`type` вставляет мгновенно)

Файл: `lib/client.js` (`STEALTH_JS`, обработчик `type`).

## Что нельзя сделать в плагине

Проверено по коду DSH (`browser-guests.js`), не наши ограничения:

- **Постоянный профиль Chromium.** `browser.acquire()` выдаёт
  `dsh-sidebar-browser-<uuid>` без префикса `persist:`. Обходим сохранением
  состояния в файл (сделано, но не автоматически).
- **Скачивания.** `configureSession` делает `will-download → preventDefault()`.
  Обходим через `fetch` в странице (сделано).
- **Прокси.** `session.setProxy` — только main-процесс.
- **Блокировка рекламы.** `webRequest` — только main-процесс.

Если это нужно по-настоящему — писать в DSH, а не в плагин.
