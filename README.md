# Hakurei-Yatsumi

Local-first prototype of Hakurei Yatsumi: Python FastAPI + SQLite + Node.js Express gateway.

## Windows

Double-click `Hakurei-Yatsumi.bat` from the project folder. The installer checks Python >=3.10 and Node.js >=20, attempts to install missing runtimes, installs dependencies, applies SQLite migrations, and starts both local services. Internet access is required for first-time dependencies. Windows x64 is assumed for fallback installers. Windows compatibility (including Cyrillic paths and parenthesized paths) has not yet been fully tested.

- FastAPI documentation: http://127.0.0.1:8000/docs
- Node gateway: http://127.0.0.1:3000/api
- Both services bind to localhost; this is not a public deployment.

## Manual setup

```bash
python -m venv .venv
# activate the virtual environment
python -m pip install -r backend/requirements.txt
cd frontend && npm install && cd ..
# set YATSUMI_API_KEY to a long random secret
python -m backend.app.db
uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
# separate terminal: cd frontend && npm start
```

## Database

Migration: `backend/migrations/001_initial.sql`. Tables: users, conversations, messages, memories, character_settings, events, schema_migrations. Database files and secrets are excluded by `.gitignore`.

## Tests

Run `python -m pytest tests -q` from the repository root after installing backend dependencies. This prototype provides storage and APIs, not a complete chat UI or an LLM integration.


## Windows diagnostics and recovery

- Double-click `Hakurei-Yatsumi.bat`. The launcher uses the BAT directory and passes Unicode paths to PowerShell. Spaces, Cyrillic, parentheses, and alternate drive letters are supported by design.
- `logs/startup.log` records dependency checks, installation attempts, retries, migrations, service PIDs, health checks, and failures. `logs/python.log` and `logs/node.log` contain server output.
- If Python >=3.10 or Node.js >=20 is missing, the launcher tries `winget` (user scope), then signed official Windows x64 installers. Internet access and potentially administrator permission are needed.
- A moved or broken `.venv` is recreated. Python and Node package installation is retried once.
- Both services are checked for up to 30 seconds each. Ports 8000/3000 must be free. A failed startup stops processes launched by this attempt.
- **Verification:** Python API tests and Node syntax checks passed on Linux. Real Windows PowerShell 5.1 execution, Cyrillic paths, and installers have not been tested on Windows yet.


## BAT v3: Windows setup and recovery

Run `Hakurei-Yatsumi.bat` on Windows. PowerShell 5.1 script: `scripts/setup-and-start.ps1`.

- Preflight checks Windows, write permissions, disk space (fixed disks), and occupied ports. Network drives are warned about, not silently rejected.
- Detects Python 3.10+ and Node.js 20+; attempts winget user-scope installation or signed official x64 installers if absent. The first run needs internet. Some Windows ARM64 and custom installs require manual setup.
- Python and npm commands have checked exit codes and one retry. Invalid or relocated Python venv is recreated.
- SQLite `PRAGMA integrity_check` and an online backup to `backend/data/backups` run before migrations. Backups are excluded from Git by `*.db`.
- Logs: `logs/startup.log`, `logs/python.stdout.log`, `logs/python.stderr.log`, `logs/node.stdout.log`, `logs/node.stderr.log`. Logs rotate to `.old` at 2 MiB. `logs/diagnostics.txt` contains no API keys.
- Process state: `logs/services.json`. A second launch detects healthy services; stale managed processes are stopped only if PID, executable path and start time match. Stop with `powershell -NoProfile -File scripts/stop.ps1 -ProjectRoot .`.
- Offline mode after first successful installation: `powershell -NoProfile -File scripts/setup-and-start.ps1 -ProjectRoot . -Offline -NoBrowser`. Missing dependencies produce explicit errors.
- Preflight-only: `powershell -NoProfile -File scripts/setup-and-start.ps1 -ProjectRoot . -Diagnostics -NoBrowser`.
- Windows CI tests normal paths, Cyrillic/parentheses/apostrophe paths and a `subst P:` mapped drive. `subst` does **not** test a real SMB network drive.
- Real Windows CI results must be checked in the repository Actions tab; a workflow file alone does not establish a passing run.

**Security:** Localhost-only prototype. Do not expose port 3000 publicly; the Node gateway uses a shared local API key, not per-user authentication.

## Node Gateway v3 (local-only, no website required)

- Node 20+ / Express gateway binds to `127.0.0.1:3000`; Python binds to `127.0.0.1:8000`.
- `GET /gateway/health` checks the authenticated Python `/health` endpoint and SQLite connectivity. Returns 503 if unavailable.
- `/api/*` forwards requests to the local Python API with an internal API key, request ID, 10-second timeout and no redirect following. The gateway rejects remote `PYTHON_API_URL` values, foreign browser Origins, unsupported methods and oversized JSON.
- Local `ws://127.0.0.1:3000/ws` requires `x-api-key` on the WebSocket upgrade. The current protocol supports `ready`, `ping` and `pong` only; **AI streaming and voice are not implemented yet**.
- POST requests pass through a bounded in-memory concurrency queue. It is **not durable**; queued work is lost on process termination.
- Structured JSON operational logs omit message bodies, API keys and query strings. Optional `YATSUMI_NODE_LOG` enables a 2 MiB rotated log file. Existing BAT stdout/stderr logs remain.
- PowerShell watchdog checks service health every 15 seconds and attempts at most 3 offline restarts per 5 minutes. `scripts/stop.ps1` stops the watchdog and managed services. Disable watchdog with `-NoWatchdog` when running the PowerShell installer directly.
- Gateway settings: `YATSUMI_NODE_PORT` (default 3000), `YATSUMI_PROXY_TIMEOUT_MS` (10000), `YATSUMI_QUEUE_LIMIT` (32), `YATSUMI_QUEUE_CONCURRENCY` (2), `YATSUMI_NODE_LOG`.
- Run `cd frontend && npm install && npm test` for Node tests, or `python -m pytest tests -q` for Python tests. Windows CI runs both plus BAT launch scenarios.
- **Security boundary:** this remains a localhost-only single-user prototype, not an authenticated multi-user web service. Do not expose port 3000 to the internet.

## Веб-интерфейс и Cloud.ru Foundation Models

Запустите `Hakurei-Yatsumi.bat` — браузер откроет `http://127.0.0.1:3000/`. Нажмите **векторную шестерёнку в правом верхнем углу** и выполните три шага:

1. Вставьте **API-ключ Foundation Models** от Cloud.ru. Ключ остаётся в памяти локального Node-процесса и не записывается в браузерное хранилище или SQLite. После перезапуска потребуется вставить его снова.
2. Каталог моделей загружается автоматически через `GET https://foundation-models.api.cloud.ru/v1/models`; выберите модель.
3. Нажмите **Подключить модель**. Сервер отправляет короткий проверочный запрос `POST /v1/chat/completions`. **Зелёный** индикатор означает успешный ответ модели; **красный** — нет подтверждённого подключения. Проверка может расходовать небольшое число токенов.

Сообщения чата отправляются через локальный Node-сервер в Cloud.ru; ключ никогда не передаётся браузеру обратно. Модели работают в облаке, локальные LLM не требуются. Для доступа нужен действующий ключ, интернет и доступ к Cloud.ru.

**Безопасность:** интерфейс предназначен только для локального использования на доверенном компьютере. Не публикуйте порт 3000 и не открывайте его другим пользователям: это локальное приложение без многопользовательской авторизации. История чата пока хранится в памяти вкладки, не в SQLite.

Официальная документация: https://cloud.ru/docs/foundation-models/ug/topics/api-ref

## Cloud Connector v2 — диагностика и потоковые ответы

- Cloud.ru HTTP 400–504 классифицируются и возвращаются локальному интерфейсу как `{error,code,status}` без тела ответа провайдера и без ключа.
- Сетевые сбои DNS/TLS/timeout и некорректный JSON получают отдельные диагностические коды.
- Только чтение каталога `GET /models` повторяется до двух раз с ограниченным ожиданием и учётом `Retry-After`. **Генерация не повторяется автоматически**, чтобы избежать повторного расхода токенов.
- Каталог исключает модели с явно распознаваемым назначением embedding/rerank/OCR/speech. Это эвристика по ID и типу, а не гарантированное определение возможностей API.
- Чат использует `POST /cloud/chat/stream` и передаёт фрагменты ответа через SSE. Клиент отображает текст по мере получения.
- Настройки показывают накопленные токены из поля `usage`, когда Cloud.ru его возвращает. Для потоковой генерации учёт зависит от наличия `usage` в SSE.
- Выбранный ID модели сохраняется в браузере, но **API-ключ не сохраняется**. После перезапуска Node ключ нужно ввести снова.
- Индикатор подключения краснеет при ошибке авторизации/доступа; разовая сетевая ошибка запроса не сбрасывает ранее подтверждённое подключение.
- Запуск тестов: `cd frontend && npm install && npm test`. Без действующего Cloud.ru API-ключа тесты проверяют только имитации ответов, не реальное облачное подключение.

## Yatsumi Core v1

Ядро находится в `frontend/core.js` и работает через Node Gateway. Генерация текста выполняется **только в Cloud.ru**; локальная Python-служба используется для SQLite, а не для LLM.

- **Личность:** системный контекст описывает Яцуми и её стиль ответа.
- **Контекст:** до 20 последних сообщений и до шести релевантных заметок по пересечению слов.
- **Память:** явное сохранение фактов в настройках сайта через `POST /core/memory`. Автоматического извлечения личных данных из диалогов нет.
- **История:** после успешной генерации пара пользователь/ассистент сохраняется в SQLite; `GET /core/history` восстанавливает последние 30 сообщений.
- **Хранилище:** используются существующие таблицы users, conversations, messages, memories и защищённый внутренним ключом Python API. `GET /core/session/{user_id}` находит последний разговор.
- **Ограничение v1:** один локальный владелец `local-owner`, один активный диалог, нет мультипользовательской изоляции. Не публикуйте локальный Node Gateway в интернет.
- **Важное:** если Python/SQLite недоступны, новый диалог через Core не начнётся, даже если Cloud.ru доступен. При ошибке записи ответ не считается успешно завершённым.
- **Тесты:** `cd frontend && npm test` проверяет модули Core и Cloud на моках. Реальная интеграция требует запуска Node, Python, SQLite и действительного ключа Cloud.ru.
