import os
import sqlite3
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient


def test_atomic_idempotent_core_turn_and_rollback():
    os.environ["YATSUMI_API_KEY"] = "test-secret"
    from backend.app import db as storage
    from backend.app.main import app
    old_path = storage.DB_PATH
    with tempfile.TemporaryDirectory() as tmp:
        storage.DB_PATH = Path(tmp) / "core-v21.db"
        try:
            with TestClient(app, raise_server_exceptions=False) as client:
                headers = {"x-api-key": "test-secret"}
                user = client.post("/users", json={"external_id": "test-core", "display_name": "Owner"}, headers=headers).json()
                conversation = client.post("/conversations", json={"user_id": user["id"]}, headers=headers).json()
                cid = conversation["id"]
                request_id = str(uuid4())
                path = f"/core/conversations/{cid}/turns"
                payload = {"request_id": request_id, "user_content": "Вопрос", "assistant_content": "Ответ"}
                missing = client.get(f"{path}/{request_id}", headers=headers)
                assert missing.status_code == 404
                first = client.post(path, json=payload, headers=headers)
                assert first.status_code == 200, first.text
                assert first.json()["duplicate"] is False
                duplicate = client.post(path, json=payload, headers=headers)
                assert duplicate.status_code == 200
                assert duplicate.json()["duplicate"] is True
                assert client.post(path, json={**payload, "assistant_content": "Другой ответ"}, headers=headers).status_code == 409
                assert client.get(f"{path}/{request_id}", headers=headers).json()["assistant_content"] == "Ответ"
                assert len(client.get(f"/conversations/{cid}/messages", headers=headers).json()) == 2

                with storage.connection() as conn:
                    conn.execute("""CREATE TRIGGER fail_assistant BEFORE INSERT ON messages
                        WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END""")
                failed_id = str(uuid4())
                failed = client.post(path, json={**payload, "request_id": failed_id}, headers=headers)
                assert failed.status_code >= 400
                assert len(client.get(f"/conversations/{cid}/messages", headers=headers).json()) == 2
                assert client.get(f"{path}/{failed_id}", headers=headers).status_code == 404
                with storage.connection() as conn:
                    conn.execute("DROP TRIGGER fail_assistant")
                recovered = client.post(path, json={**payload, "request_id": failed_id}, headers=headers)
                assert recovered.status_code == 200, recovered.text
                assert len(client.get(f"/conversations/{cid}/messages", headers=headers).json()) == 4
        finally:
            storage.DB_PATH = old_path


def test_core_turn_requires_authentication():
    os.environ["YATSUMI_API_KEY"] = "test-secret"
    from backend.app.main import app
    with TestClient(app) as client:
        response = client.post("/core/conversations/1/turns", json={
            "request_id": str(uuid4()), "user_content": "x", "assistant_content": "y"
        })
        assert response.status_code == 401
