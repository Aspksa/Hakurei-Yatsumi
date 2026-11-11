CREATE TABLE IF NOT EXISTS core_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  user_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(conversation_id, request_id)
);
CREATE INDEX IF NOT EXISTS idx_core_turns_conversation ON core_turns(conversation_id,id);
