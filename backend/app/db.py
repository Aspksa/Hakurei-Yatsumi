import os
import sqlite3
from contextlib import contextmanager
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

def migrate():
    with connection() as db:
        db.execute("PRAGMA journal_mode=WAL")
        db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
        applied = {r["version"] for r in db.execute("SELECT version FROM schema_migrations")}
        for migration in sorted(MIGRATIONS.glob("*.sql")):
            if migration.name not in applied:
                safe_name = migration.name.replace("'", "''")
                script = migration.read_text(encoding="utf-8")
                db.executescript("BEGIN IMMEDIATE;\n" + script + "\nINSERT INTO schema_migrations(version) VALUES ('" + safe_name + "');\nCOMMIT;")

if __name__ == "__main__":
    migrate()
    print(f"Migrated {DB_PATH}")
