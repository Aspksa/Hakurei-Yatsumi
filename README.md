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
