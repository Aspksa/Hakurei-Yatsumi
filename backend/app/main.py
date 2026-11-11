from contextlib import asynccontextmanager
import hmac
import json
import os
import re
import sqlite3
from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from .db import connection, migrate

API_KEY = os.getenv("YATSUMI_API_KEY")
if not API_KEY:
    raise RuntimeError("Set YATSUMI_API_KEY in the environment")

def authenticate(x_api_key: str | None = Header(default=None)):
    if not x_api_key or not hmac.compare_digest(x_api_key.encode(), API_KEY.encode()):
        raise HTTPException(401, "Unauthorized")

@asynccontextmanager
async def lifespan(app: FastAPI):
    migrate()
    yield

app = FastAPI(title="Hakurei Yatsumi API", lifespan=lifespan, dependencies=[Depends(authenticate)])

class UserIn(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=128)

class ConversationIn(BaseModel):
    user_id: int
    title: str = Field(default="Новый разговор", max_length=200)

class MessageIn(BaseModel):
    role: str
    content: str = Field(min_length=1, max_length=100000)

class MemoryIn(BaseModel):
    user_id: int
    key: str = Field(min_length=1, max_length=128)
    value: str = Field(max_length=10000)

@app.get("/health")
def health():
    try:
        with connection() as db:
            db.execute("SELECT 1 FROM schema_migrations LIMIT 1").fetchone()
        return {"status": "ok", "sqlite": "ok"}
    except sqlite3.Error:
        raise HTTPException(503, "SQLite unavailable")

@app.post("/users", status_code=201)
def create_user(data: UserIn):
    with connection() as db:
        db.execute("INSERT INTO users(external_id,display_name) VALUES (?,?) ON CONFLICT(external_id) DO UPDATE SET display_name=excluded.display_name", (data.external_id, data.display_name))
        return dict(db.execute("SELECT * FROM users WHERE external_id=?", (data.external_id,)).fetchone())

@app.post("/conversations", status_code=201)
def create_conversation(data: ConversationIn):
    with connection() as db:
        try:
            cursor = db.execute("INSERT INTO conversations(user_id,title) VALUES (?,?)", (data.user_id, data.title))
        except sqlite3.IntegrityError:
            raise HTTPException(404, "User not found")
        return dict(db.execute("SELECT * FROM conversations WHERE id=?", (cursor.lastrowid,)).fetchone())

@app.get("/conversations/{conversation_id}/messages")
def get_messages(conversation_id: int, limit: int = 100):
    if not 1 <= limit <= 500:
        raise HTTPException(422, "limit must be 1..500")
    with connection() as db:
        if not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
            raise HTTPException(404, "Conversation not found")
        rows = db.execute("SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT ?", (conversation_id, limit)).fetchall()
        return [dict(row) for row in reversed(rows)]

@app.post("/conversations/{conversation_id}/messages", status_code=201)
def add_message(conversation_id: int, data: MessageIn):
    if data.role not in ("user", "assistant", "system"):
        raise HTTPException(422, "Invalid role")
    with connection() as db:
        try:
            cursor = db.execute("INSERT INTO messages(conversation_id,role,content) VALUES (?,?,?)", (conversation_id, data.role, data.content))
        except sqlite3.IntegrityError:
            raise HTTPException(404, "Conversation not found")
        return dict(db.execute("SELECT * FROM messages WHERE id=?", (cursor.lastrowid,)).fetchone())

@app.put("/memories")
def upsert_memory(data: MemoryIn):
    with connection() as db:
        try:
            db.execute("INSERT INTO memories(user_id,memory_key,memory_value) VALUES (?,?,?) ON CONFLICT(user_id,memory_key) DO UPDATE SET memory_value=excluded.memory_value,updated_at=CURRENT_TIMESTAMP", (data.user_id, data.key, data.value))
        except sqlite3.IntegrityError:
            raise HTTPException(404, "User not found")
        return dict(db.execute("SELECT * FROM memories WHERE user_id=? AND memory_key=?", (data.user_id, data.key)).fetchone())

@app.get("/users/{user_id}/memories")
def list_memories(user_id: int):
    with connection() as db:
        return [dict(r) for r in db.execute("SELECT * FROM memories WHERE user_id=? ORDER BY id", (user_id,))]

@app.get("/character")
def character():
    with connection() as db:
        return {r["key"]: r["value"] for r in db.execute("SELECT key,value FROM character_settings")}

@app.post("/events", status_code=201)
def create_event(user_id: int | None, event_type: str, details: str = "{}"):
    try:
        parsed = json.loads(details)
    except json.JSONDecodeError:
        raise HTTPException(422, "Invalid JSON details")
    with connection() as db:
        try:
            cursor = db.execute("INSERT INTO events(user_id,event_type,details) VALUES (?,?,?)", (user_id, event_type, json.dumps(parsed, ensure_ascii=False)))
        except sqlite3.IntegrityError:
            raise HTTPException(404, "User not found")
        return {"id": cursor.lastrowid}



REQUEST_ID_PATTERN = r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"


class CoreTurnIn(BaseModel):
    request_id: str = Field(pattern=REQUEST_ID_PATTERN)
    user_content: str = Field(min_length=1, max_length=8000)
    assistant_content: str = Field(min_length=1, max_length=200000)

def read_core_turn(db, conversation_id: int, request_id: str):
    row = db.execute(
        """SELECT t.request_id, u.content AS user_content, a.content AS assistant_content
           FROM core_turns t
           JOIN messages u ON u.id=t.user_message_id
           JOIN messages a ON a.id=t.assistant_message_id
           WHERE t.conversation_id=? AND t.request_id=?""",
        (conversation_id, request_id),
    ).fetchone()
    return dict(row) if row else None

@app.get("/core/conversations/{conversation_id}/turns/{request_id}")
def get_core_turn(conversation_id: int, request_id: str):
    if not re.fullmatch(REQUEST_ID_PATTERN, request_id):
        raise HTTPException(422, "Invalid request ID")
    with connection() as db:
        result = read_core_turn(db, conversation_id, request_id)
        if not result:
            raise HTTPException(404, "Turn not found")
        return result

@app.post("/core/conversations/{conversation_id}/turns")
def save_core_turn(conversation_id: int, data: CoreTurnIn):
    # BEGIN IMMEDIATE serializes concurrent writers; the UNIQUE constraint makes retries safe.
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        if not db.execute("SELECT 1 FROM conversations WHERE id=?", (conversation_id,)).fetchone():
            raise HTTPException(404, "Conversation not found")
        existing = read_core_turn(db, conversation_id, data.request_id)
        if existing:
            if existing["user_content"] != data.user_content or existing["assistant_content"] != data.assistant_content:
                raise HTTPException(409, "Request ID already belongs to another turn")
            return {**existing, "duplicate": True}
        user_id = db.execute(
            "INSERT INTO messages(conversation_id,role,content) VALUES (?, 'user', ?)",
            (conversation_id, data.user_content),
        ).lastrowid
        assistant_id = db.execute(
            "INSERT INTO messages(conversation_id,role,content) VALUES (?, 'assistant', ?)",
            (conversation_id, data.assistant_content),
        ).lastrowid
        db.execute(
            "INSERT INTO core_turns(conversation_id,request_id,user_message_id,assistant_message_id) VALUES (?,?,?,?)",
            (conversation_id, data.request_id, user_id, assistant_id),
        )
        return {"request_id": data.request_id, "user_content": data.user_content,
                "assistant_content": data.assistant_content, "duplicate": False}

@app.get("/core/session/{user_id}")
def core_session(user_id: int):
    """Return the latest conversation for the local owner; no duplicate session per restart."""
    with connection() as db:
        row = db.execute(
            "SELECT id FROM conversations WHERE user_id=? ORDER BY id DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        return {"conversation_id": row["id"] if row else None}


@app.post("/core/session/{user_id}")
def initialize_core_session(user_id: int):
    with connection() as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute(
            "SELECT id FROM conversations WHERE user_id=? ORDER BY id DESC LIMIT 1",
            (user_id,),
        ).fetchone()
        if row:
            return {"conversation_id": row["id"]}
        if not db.execute("SELECT 1 FROM users WHERE id=?", (user_id,)).fetchone():
            raise HTTPException(404, "User not found")
        cursor = db.execute(
            "INSERT INTO conversations(user_id,title) VALUES (?,?)",
            (user_id, "Яцуми — основной диалог"),
        )
        return {"conversation_id": cursor.lastrowid}
