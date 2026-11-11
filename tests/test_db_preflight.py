import os
import sqlite3
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from backend.app import db as storage

def test_sqlite_backup_and_migration(tmp_path):
    db = tmp_path / "database.db"
    env = dict(os.environ, YATSUMI_DB_PATH=str(db))
    cmd = [sys.executable, "-m", "backend.app.db"]
    subprocess.run(cmd, check=True, env=env)
    subprocess.run(cmd + ["--preflight"], check=True, env=env)
    backups = list((tmp_path / "backups").glob("*.db"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as connection:
        assert connection.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    subprocess.run(cmd, check=True, env=env)

def test_corrupt_db_rejected(tmp_path):
    db = tmp_path / "corrupt.db"
    db.write_bytes(b"not a sqlite database")
    env = dict(os.environ, YATSUMI_DB_PATH=str(db))
    result = subprocess.run([sys.executable, "-m", "backend.app.db", "--preflight"], env=env, capture_output=True)
    assert result.returncode != 0

def test_concurrent_migrations_are_idempotent(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "DB_PATH", tmp_path / "concurrent.db")
    with ThreadPoolExecutor(8) as pool:
        list(pool.map(lambda _: storage.migrate(), range(8)))
    with storage.connection() as db:
        assert db.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        applied = [row["version"] for row in db.execute("SELECT version FROM schema_migrations ORDER BY version")]
    assert applied == [path.name for path in sorted(storage.MIGRATIONS.glob("*.sql"))]
