def test_api():
    import os
    import tempfile
    from pathlib import Path
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["YATSUMI_DB_PATH"] = str(Path(tmp) / "test.db")
        os.environ["YATSUMI_API_KEY"] = "test-secret"
        from fastapi.testclient import TestClient
        from backend.app.main import app
        with TestClient(app) as client:
            h = {"x-api-key": "test-secret"}
            assert client.get("/health", headers=h).json()["status"] == "ok"
            assert client.get("/health").status_code == 401
            user = client.post("/users", json={"external_id":"owner","display_name":"Owner"}, headers=h)
            assert user.status_code == 201
            uid = user.json()["id"]
            conv = client.post("/conversations", json={"user_id":uid}, headers=h)
            assert conv.status_code == 201
            cid = conv.json()["id"]
            assert client.post(f"/conversations/{cid}/messages", json={"role":"user","content":"Привет"}, headers=h).status_code == 201
            assert len(client.get(f"/conversations/{cid}/messages", headers=h).json()) == 1
            assert client.put("/memories", json={"user_id":uid,"key":"language","value":"ru"}, headers=h).status_code == 200
            assert client.get(f"/users/{uid}/memories", headers=h).json()[0]["memory_value"] == "ru"
