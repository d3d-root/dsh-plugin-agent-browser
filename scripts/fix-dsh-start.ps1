<#
.SYNOPSIS
  Починка запуска DeepSeek Harness: убирает устаревшие служебные cookies.

.DESCRIPTION
  DSH хранит cookie локальной авторизации в базе Chromium. Каждый запуск
  приложения поднимает локальный сервер на новом порту и добавляет новую
  служебную cookie для 127.0.0.1. Старые записи не удаляются и копятся.

  Когда их становится слишком много, при старте DSH получает ошибку
  "desktop welcome: Web authentication failed" и вместо рабочего окна
  показывает экран ошибки. Переустановка той же версии не помогает: дело не
  в файлах приложения, а в базе cookies.

  Скрипт удаляет ТОЛЬКО служебные cookies локального хоста (127.0.0.1 и
  localhost). Cookies сайтов, история, задачи, настройки и плагины остаются
  нетронутыми.

.PARAMETER Check
  Только показать, что найдено. Ничего не менять.

.PARAMETER Restore
  Вернуть последнюю резервную копию базы cookies на место.

.EXAMPLE
  .\fix-dsh-start.ps1 -Check
  .\fix-dsh-start.ps1
  .\fix-dsh-start.ps1 -Restore
#>
[CmdletBinding()]
param(
  [switch]$Check,
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "`n== $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "   OK: $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "   !  $text" -ForegroundColor Yellow }
function Write-Err($text) { Write-Host "   X  $text" -ForegroundColor Red }

# --- где что лежит -----------------------------------------------------------

$cookiesDir = Join-Path $env:APPDATA '@deepseek-ai\dsh-desktop\Network'
$cookiesDb = Join-Path $cookiesDir 'Cookies'

if (-not (Test-Path $cookiesDb)) {
  Write-Err "Не нашёл базу cookies: $cookiesDb"
  Write-Host "   Похоже, DSH ни разу не запускался на этой машине."
  exit 1
}

# Python нужен только ради sqlite: в комплекте с DSH он уже есть.
function Find-Python {
  $candidates = @()
  $runtimes = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes'
  if (Test-Path $runtimes) {
    $candidates += Get-ChildItem $runtimes -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match 'dependencies\\python\\python\.exe$' } |
      Select-Object -ExpandProperty FullName
  }
  $candidates += (Get-Command python -ErrorAction SilentlyContinue).Source
  foreach ($path in $candidates) {
    if ($path -and (Test-Path $path)) {
      try {
        & $path -c "import sqlite3" 2>$null
        if ($LASTEXITCODE -eq 0) { return $path }
      } catch { }
    }
  }
  return $null
}

$python = Find-Python
if (-not $python) {
  Write-Err "Не нашёл Python со sqlite3 (обычно он лежит в ~\.dsh\dsh-runtimes)."
  exit 1
}

# --- DSH должен быть закрыт --------------------------------------------------

Write-Step 'Проверяю, закрыт ли DSH'
$running = Get-Process -Name '*Harness*' -ErrorAction SilentlyContinue
if ($running) {
  Write-Err "DSH ещё работает (процессов: $($running.Count))."
  Write-Host "   Закройте приложение: меню -> «Выход». Затем запустите скрипт снова." -ForegroundColor Yellow
  Write-Host "   Так база cookies не будет изменена под работающим приложением." -ForegroundColor Yellow
  exit 2
}
Write-Ok 'DSH закрыт, база не занята'

# --- восстановление из копии -------------------------------------------------

if ($Restore) {
  Write-Step 'Восстанавливаю последнюю резервную копию'
  $backups = Get-ChildItem $cookiesDir -Filter 'Cookies.backup-*' -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notmatch 'journal$' } |
    Sort-Object LastWriteTime -Descending
  if (-not $backups) {
    Write-Err 'Резервных копий не найдено.'
    exit 1
  }
  $latest = $backups[0]
  Write-Host "   Копия: $($latest.Name)  ($($latest.LastWriteTime))"
  Copy-Item $cookiesDb "$cookiesDb.before-restore-$(Get-Date -Format 'yyyyMMdd-HHmmss')" -Force
  Copy-Item $latest.FullName $cookiesDb -Force
  Remove-Item (Join-Path $cookiesDir 'Cookies-journal') -Force -ErrorAction SilentlyContinue
  Write-Ok "База восстановлена из $($latest.Name)"
  exit 0
}

# --- смотрим, что внутри -----------------------------------------------------

$inspect = Join-Path $env:TEMP "dsh-cookies-inspect-$(Get-Random).py"
@'
import sqlite3, sys, json
db = sys.argv[1]
con = sqlite3.connect(db, timeout=5)
cur = con.cursor()
out = {}
cur.execute("select count(*) from cookies")
out["total"] = cur.fetchone()[0]
cur.execute("select count(*) from cookies where host_key like '%127.0.0.1%' or host_key like '%localhost%'")
out["local"] = cur.fetchone()[0]
cur.execute("select host_key, count(*) from cookies group by host_key order by count(*) desc limit 5")
out["hosts"] = cur.fetchall()
con.close()
print(json.dumps(out))
'@ | Set-Content -Path $inspect -Encoding UTF8

Write-Step 'Что в базе cookies'
$raw = & $python $inspect $cookiesDb
if ($LASTEXITCODE -ne 0) {
  Remove-Item $inspect -Force -ErrorAction SilentlyContinue
  Write-Err 'Не смог прочитать базу cookies.'
  exit 1
}
Remove-Item $inspect -Force -ErrorAction SilentlyContinue
$info = $raw | ConvertFrom-Json

Write-Host "   Всего cookies: $($info.total)"
Write-Host "   Служебных для локального хоста: $($info.local)"
foreach ($row in $info.hosts) { Write-Host "     $($row[0]) : $($row[1])" }

if ($info.local -eq 0) {
  Write-Warn2 'Служебных cookies нет — дело не в них.'
  Write-Host "   Значит причина другая. Откройте DSH и посмотрите свежий журнал:" -ForegroundColor Yellow
  Write-Host "   $env:APPDATA\@deepseek-ai\dsh-desktop\logs\crash-*.log" -ForegroundColor Yellow
  exit 0
}

if ($Check) {
  Write-Step 'Режим проверки: ничего не меняю'
  Write-Host "   Чтобы починить, запустите без -Check:  .\fix-dsh-start.ps1" -ForegroundColor Yellow
  exit 0
}

# --- резервная копия ---------------------------------------------------------

Write-Step 'Делаю резервную копию'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path $cookiesDir "Cookies.backup-$stamp"
Copy-Item $cookiesDb $backup -Force
$hash = (Get-FileHash $backup -Algorithm SHA256).Hash
Write-Ok "Копия: $backup"
Write-Host "   SHA-256: $hash"

# --- удаляем только локальные ------------------------------------------------

$clean = Join-Path $env:TEMP "dsh-cookies-clean-$(Get-Random).py"
@'
import sqlite3, sys, json
db = sys.argv[1]
con = sqlite3.connect(db, timeout=10)
cur = con.cursor()
cur.execute("delete from cookies where host_key like '%127.0.0.1%' or host_key like '%localhost%'")
removed = cur.rowcount
con.commit()
cur.execute("pragma quick_check")
check = cur.fetchone()[0]
cur.execute("select count(*) from cookies")
left = cur.fetchone()[0]
con.close()
print(json.dumps({"removed": removed, "check": check, "left": left}))
'@ | Set-Content -Path $clean -Encoding UTF8

Write-Step 'Удаляю служебные cookies локального хоста'
$result = & $python $clean $cookiesDb
Remove-Item $clean -Force -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) {
  Write-Err 'Не удалось изменить базу.'
  Write-Host "   Вернуть как было:  .\fix-dsh-start.ps1 -Restore" -ForegroundColor Yellow
  exit 1
}
$res = $result | ConvertFrom-Json
Write-Ok "Удалено записей: $($res.removed)"
Write-Host "   Осталось cookies: $($res.left)"
Write-Host "   Целостность базы (quick_check): $($res.check)"
if ($res.check -ne 'ok') {
  Write-Err 'База повреждена. Восстановите копию:  .\fix-dsh-start.ps1 -Restore'
  exit 1
}

Write-Step 'Готово'
Write-Host '   Запускайте DSH. Резервная копия на месте:' -ForegroundColor Green
Write-Host "   $backup" -ForegroundColor Green
Write-Host ''
Write-Host '   Если снова понадобится — причина та же: каждый перезапуск' -ForegroundColor Gray
Write-Host '   добавляет служебную cookie. Частые перезапуски копят их быстрее.' -ForegroundColor Gray
