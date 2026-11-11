import os
import sqlite3
import subprocess
import sys
from pathlib import Path

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
