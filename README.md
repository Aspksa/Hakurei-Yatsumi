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
