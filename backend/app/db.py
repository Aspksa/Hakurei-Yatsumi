import argparse
import os
import sqlite3
from time import monotonic, sleep
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(os.getenv("YATSUMI_DB_PATH", str(Path(__file__).resolve().parents[1] / "data" / "yatsumi.db")))
MIGRATIONS = Path(__file__).resolve().parents[1] / "migrations"

@contextmanager
def connection():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB_PATH, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=5000")
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()

def preflight():
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not DB_PATH.exists():
        return None
    with closing(sqlite3.connect(DB_PATH, timeout=10)) as source:
        result = source.execute("PRAGMA integrity_check").fetchone()[0]
        if result != "ok":
            raise RuntimeError("SQLite integrity_check failed: " + result)
        backup_dir = DB_PATH.parent / "backups"
        backup_dir.mkdir(parents=True, exist_ok=True)
        destination = backup_dir / (DB_PATH.stem + "-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".db")
        with closing(sqlite3.connect(destination)) as target:
            source.backup(target)
        with closing(sqlite3.connect(destination)) as check:
            backup_ok = check.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        if not backup_ok:
            destination.unlink(missing_ok=True)
            raise RuntimeError("SQLite backup integrity check failed")
    return destination

def enable_wal(db):
    deadline = monotonic() + 5
    while True:
        try:
            db.execute("PRAGMA journal_mode=WAL")
            return
        except sqlite3.OperationalError as error:
            if str(error) != "database is locked" or monotonic() >= deadline:
                raise
            sleep(0.05)


def migrate():
    with connection() as db:
        enable_wal(db)
        db.execute("BEGIN IMMEDIATE")
        db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        applied = {row["version"] for row in db.execute("SELECT version FROM schema_migrations")}
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            if migration.name in applied:
                continue
            statement = ""
            for part in migration.read_text(encoding="utf-8").split(";"):
                if not part and not statement:
                    continue
                statement += part + ";"
                if sqlite3.complete_statement(statement):
                    db.execute(statement)
                    statement = ""
            if statement.strip():
                db.execute(statement)
            db.execute("INSERT INTO schema_migrations(version) VALUES (?)", (migration.name,))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preflight", action="store_true")
    args = parser.parse_args()
    if args.preflight:
        print("SQLite preflight OK; backup:", preflight())
    else:
        migrate()
        print("Migrated", DB_PATH)
