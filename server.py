#!/usr/bin/env python3
"""
LM Studio Chat — server.py
Serves static files + REST API for SQLite conversations + streaming proxy to LM Studio.
"""

import http.server, json, re, sqlite3, socket, threading, time, urllib.parse, urllib.request
from datetime import datetime
from pathlib  import Path

# ════════════════════════════════════════════════════════
# CONFIGURATION — edit these values before deploying
# ════════════════════════════════════════════════════════

PORT    = 8000          # port this server listens on
HOST    = "0.0.0.0"    # 0.0.0.0 = reachable from all devices on the network

# IP address of the machine running LM Studio.
# If LM Studio runs on the SAME machine as this server → use 127.0.0.1
# If LM Studio runs on a DIFFERENT machine          → use its local IP (e.g. 192.168.0.48)
LM_URL  = "http://192.168.0.48:1234"

DB_FILE    = "conversations.db"     # SQLite file created automatically on first run
STATIC_DIR = Path(__file__).parent  # folder containing index.html / style.css / script.js

# ════════════════════════════════════════════════════════
# DATABASE
# ════════════════════════════════════════════════════════

_db_lock  = threading.Lock()
_db_local = threading.local()

def get_db():
    if not getattr(_db_local, "conn", None):
        _db_local.conn = sqlite3.connect(DB_FILE, check_same_thread=False)
        _db_local.conn.row_factory = sqlite3.Row
        _db_local.conn.execute("PRAGMA journal_mode=WAL")
        _db_local.conn.execute("PRAGMA foreign_keys=ON")
    return _db_local.conn

def init_db():
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS conversations (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            model      TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS messages (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role            TEXT NOT NULL,
            content         TEXT NOT NULL,
            tokens          INTEGER DEFAULT 0,
            created_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id);
    """)
    db.commit()
    print(f"[DB] {Path(DB_FILE).absolute()}")

def now_iso():
    return datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def gen_id():
    return str(int(time.time() * 1000))

def estimate_tokens(text):
    return max(1, len(text) // 4)

# ════════════════════════════════════════════════════════
# HTTP HELPERS
# ════════════════════════════════════════════════════════

def _cors(h):
    h.send_header("Access-Control-Allow-Origin",  "*")
    h.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
    h.send_header("Access-Control-Allow-Headers", "Content-Type")

def json_resp(h, data, status=200):
    body = json.dumps(data, ensure_ascii=False, indent=2).encode()
    h.send_response(status)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Length", str(len(body)))
    _cors(h)
    h.end_headers()
    h.wfile.write(body)

def err_resp(h, msg, status=400):
    json_resp(h, {"error": msg}, status)

def read_body(h):
    n = int(h.headers.get("Content-Length", 0))
    return json.loads(h.rfile.read(n).decode()) if n else {}

# ════════════════════════════════════════════════════════
# STREAMING PROXY — core of point 2 (saves even if browser disconnects)
# ════════════════════════════════════════════════════════

def _save_exchange(conv_id, conv_title, model, user_msg, full_text, prompt_tokens, comp_tokens):
    """
    Persist user message + assistant reply to SQLite.
    Called from a background thread so it runs even after the client disconnects.
    """
    if not full_text.strip():
        return
    ts = now_iso()
    db = get_db()
    with _db_lock:
        exists = db.execute("SELECT id FROM conversations WHERE id=?", (conv_id,)).fetchone()
        if not exists:
            db.execute(
                "INSERT INTO conversations(id,title,model,created_at,updated_at) VALUES(?,?,?,?,?)",
                (conv_id, conv_title or "Conversation", model, ts, ts)
            )
            if user_msg:
                db.execute(
                    "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
                    (conv_id, "user", user_msg, prompt_tokens, ts)
                )
        else:
            db.execute("UPDATE conversations SET updated_at=?,model=? WHERE id=?", (ts, model, conv_id))
            if user_msg:
                db.execute(
                    "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
                    (conv_id, "user", user_msg, prompt_tokens, ts)
                )
        db.execute(
            "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
            (conv_id, "assistant", full_text, comp_tokens, ts)
        )
        db.commit()
    print(f"[DB] saved conv={conv_id} prompt≈{prompt_tokens} completion≈{comp_tokens} tokens")


def _stream_worker(conv_id, conv_title, model, user_msg, prompt_tokens, lm_payload, client_wfile, client_lock):
    """
    Background thread:
      1. Opens SSE stream from LM Studio
      2. Forwards each chunk to the client (best-effort — ignores broken pipe)
      3. Saves the complete response to SQLite regardless of client state
    """
    endpoints = [f"{LM_URL}/api/v1/chat", f"{LM_URL}/v1/chat/completions"]
    lm_resp   = None

    for ep in endpoints:
        try:
            req = urllib.request.Request(
                ep,
                data    = json.dumps(lm_payload).encode(),
                headers = {"Content-Type": "application/json"},
                method  = "POST",
            )
            lm_resp = urllib.request.urlopen(req, timeout=600)
            break
        except urllib.error.HTTPError as e:
            if e.code in (400, 404) and ep == endpoints[0]:
                continue
            print(f"[STREAM] LM Studio error {e.code} on {ep}")
            return
        except Exception as e:
            print(f"[STREAM] Cannot reach LM Studio: {e}")
            return

    if not lm_resp:
        return

    full_text     = ""
    comp_tokens   = 0

    for raw_line in lm_resp:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        if line == "data: [DONE]":
            try:
                with client_lock:
                    client_wfile.write(b"data: [DONE]\n\n")
                    client_wfile.flush()
            except Exception:
                pass
            break
        if not line.startswith("data: "):
            continue
        try:
            chunk = json.loads(line[6:])
            piece = (chunk.get("choices") or [{}])[0].get("delta", {}).get("content", "")
            full_text += piece
            usage = chunk.get("usage") or {}
            if usage.get("completion_tokens"):
                comp_tokens = usage["completion_tokens"]
            # Forward to client (ignore errors — client may be gone)
            try:
                with client_lock:
                    client_wfile.write(f"{line}\n\n".encode())
                    client_wfile.flush()
            except Exception:
                pass
        except json.JSONDecodeError:
            pass

    lm_resp.close()

    if comp_tokens == 0:
        comp_tokens = estimate_tokens(full_text)

    # Save regardless of whether the client is still connected
    _save_exchange(conv_id, conv_title, model, user_msg, full_text, prompt_tokens, comp_tokens)


def proxy_stream(handler, body):
    """
    Entry point for POST /api/chat/stream
    Extracts private fields (_conv_id etc.), sends SSE headers immediately,
    then launches the streaming worker in a background thread.
    """
    conv_id    = body.pop("_conv_id",    None) or gen_id()
    user_msg   = body.pop("_user_msg",   None)
    conv_title = body.pop("_conv_title", None)
    body["stream"] = True

    prompt_tokens = estimate_tokens(
        " ".join(m.get("content", "") for m in body.get("messages", []))
    )

    # Send SSE headers immediately so the browser starts receiving
    handler.send_response(200)
    handler.send_header("Content-Type",      "text/event-stream; charset=utf-8")
    handler.send_header("Cache-Control",     "no-cache")
    handler.send_header("X-Accel-Buffering", "no")
    _cors(handler)
    handler.end_headers()

    client_lock = threading.Lock()

    # Background thread — continues even if client disconnects
    t = threading.Thread(
        target  = _stream_worker,
        args    = (conv_id, conv_title, body.get("model",""), user_msg,
                   prompt_tokens, body, handler.wfile, client_lock),
        daemon  = True,
    )
    t.start()
    t.join()   # wait here so the HTTP handler doesn't close the socket early

# ════════════════════════════════════════════════════════
# HTTP HANDLER
# ════════════════════════════════════════════════════════

class ChatHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        print(f"[{datetime.now().strftime('%H:%M:%S')}] {self.command} {self.path}  →  {fmt % args}")

    def do_OPTIONS(self):
        self.send_response(204)
        _cors(self)
        self.end_headers()

    def do_GET(self):
        p  = urllib.parse.urlparse(self.path)
        pp = p.path.rstrip("/")
        qs = urllib.parse.parse_qs(p.query)

        if pp == "/api/conversations":
            self._list_convs()
        elif pp == "/api/conversations/search":
            self._search_convs(qs.get("q", [""])[0].strip())
        elif pp == "/api/export":
            self._export()
        elif m := re.fullmatch(r"/api/conversations/([^/]+)", pp):
            self._get_conv(m.group(1))
        else:
            self._static(p.path)

    def do_POST(self):
        pp = self.path.rstrip("/")
        if pp == "/api/conversations":
            self._create_conv()
        elif pp == "/api/chat/stream":
            proxy_stream(self, read_body(self))
        elif pp == "/api/import":
            self._import()
        else:
            err_resp(self, "Unknown endpoint", 404)

    def do_PUT(self):
        if m := re.fullmatch(r"/api/conversations/([^/]+)", self.path.rstrip("/")):
            self._update_conv(m.group(1))
        else:
            err_resp(self, "Unknown endpoint", 404)

    def do_DELETE(self):
        if m := re.fullmatch(r"/api/conversations/([^/]+)", self.path.rstrip("/")):
            self._delete_conv(m.group(1))
        else:
            err_resp(self, "Unknown endpoint", 404)

    # ════════════════════════════════════════════════════
    # CRUD — conversations
    # ════════════════════════════════════════════════════

    def _list_convs(self):
        db   = get_db()
        rows = db.execute("""
            SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
                   COUNT(m.id) as message_count,
                   COALESCE(SUM(m.tokens), 0) as total_tokens
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            LIMIT 200
        """).fetchall()
        json_resp(self, [dict(r) for r in rows])

    def _get_conv(self, cid):
        db   = get_db()
        conv = db.execute("SELECT * FROM conversations WHERE id=?", (cid,)).fetchone()
        if not conv:
            err_resp(self, "Not found", 404)
            return
        msgs = db.execute(
            "SELECT role, content, tokens, created_at FROM messages WHERE conversation_id=? ORDER BY id",
            (cid,)
        ).fetchall()
        r = dict(conv)
        r["messages"] = [dict(m) for m in msgs]
        json_resp(self, r)

    def _create_conv(self):
        b   = read_body(self)
        ts  = now_iso()
        cid = b.get("id") or gen_id()
        db  = get_db()
        db.execute(
            "INSERT OR REPLACE INTO conversations(id,title,model,created_at,updated_at) VALUES(?,?,?,?,?)",
            (cid, b.get("title", "New conversation"), b.get("model", ""), ts, ts)
        )
        for m in b.get("messages", []):
            db.execute(
                "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
                (cid, m["role"], m["content"], m.get("tokens", 0), ts)
            )
        db.commit()
        json_resp(self, {"id": cid, "title": b.get("title"), "created_at": ts, "updated_at": ts}, 201)

    def _update_conv(self, cid):
        b  = read_body(self)
        db = get_db()
        if not db.execute("SELECT id FROM conversations WHERE id=?", (cid,)).fetchone():
            err_resp(self, "Not found", 404)
            return
        ts  = now_iso()
        upd = ["updated_at=?"]
        par = [ts]
        if b.get("title") is not None:
            upd.append("title=?"); par.append(b["title"])
        if b.get("model") is not None:
            upd.append("model=?"); par.append(b["model"])
        par.append(cid)
        db.execute(f"UPDATE conversations SET {','.join(upd)} WHERE id=?", par)
        if b.get("messages") is not None:
            db.execute("DELETE FROM messages WHERE conversation_id=?", (cid,))
            for m in b["messages"]:
                db.execute(
                    "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
                    (cid, m["role"], m["content"], m.get("tokens", 0), ts)
                )
        db.commit()
        json_resp(self, {"id": cid, "updated_at": ts})

    def _delete_conv(self, cid):
        db = get_db()
        db.execute("DELETE FROM conversations WHERE id=?", (cid,))
        db.commit()
        json_resp(self, {"deleted": cid})

    def _search_convs(self, q):
        if not q:
            self._list_convs()
            return
        db   = get_db()
        like = f"%{q}%"
        rows = db.execute("""
            SELECT DISTINCT c.id, c.title, c.model, c.created_at, c.updated_at,
                   COUNT(m.id) as message_count,
                   COALESCE(SUM(m.tokens), 0) as total_tokens
            FROM conversations c
            LEFT JOIN messages m ON m.conversation_id = c.id
            WHERE c.title LIKE ? OR m.content LIKE ?
            GROUP BY c.id
            ORDER BY c.updated_at DESC
            LIMIT 100
        """, (like, like)).fetchall()
        json_resp(self, [dict(r) for r in rows])

    def _export(self):
        db    = get_db()
        convs = db.execute("SELECT * FROM conversations ORDER BY updated_at DESC").fetchall()
        out   = []
        for c in convs:
            msgs = db.execute(
                "SELECT role, content, tokens, created_at FROM messages WHERE conversation_id=? ORDER BY id",
                (c["id"],)
            ).fetchall()
            r = dict(c)
            r["messages"] = [dict(m) for m in msgs]
            out.append(r)
        body = json.dumps({"exported_at": now_iso(), "conversations": out},
                          ensure_ascii=False, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="lmchat_export.json"')
        self.send_header("Content-Length", str(len(body)))
        _cors(self)
        self.end_headers()
        self.wfile.write(body)

    def _import(self):
        b     = read_body(self)
        db    = get_db()
        count = 0
        for c in b.get("conversations", []):
            cid = c.get("id") or gen_id()
            ca  = c.get("created_at", now_iso())
            ua  = c.get("updated_at", now_iso())
            db.execute(
                "INSERT OR IGNORE INTO conversations(id,title,model,created_at,updated_at) VALUES(?,?,?,?,?)",
                (cid, c.get("title", "Imported"), c.get("model", ""), ca, ua)
            )
            for m in c.get("messages", []):
                db.execute(
                    "INSERT INTO messages(conversation_id,role,content,tokens,created_at) VALUES(?,?,?,?,?)",
                    (cid, m["role"], m["content"], m.get("tokens", 0), m.get("created_at", ca))
                )
            count += 1
        db.commit()
        json_resp(self, {"imported": count})

    # ════════════════════════════════════════════════════
    # STATIC FILES
    # ════════════════════════════════════════════════════

    def _static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        safe = (STATIC_DIR / path.lstrip("/")).resolve()
        if not str(safe).startswith(str(STATIC_DIR.resolve())):
            err_resp(self, "Forbidden", 403)
            return
        if not safe.exists() or not safe.is_file():
            err_resp(self, f"Not found: {path}", 404)
            return
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css" : "text/css; charset=utf-8",
            ".js"  : "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".png" : "image/png",
            ".svg" : "image/svg+xml",
            ".ico" : "image/x-icon",
        }
        content = safe.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime.get(safe.suffix.lower(), "application/octet-stream"))
        self.send_header("Content-Length", str(len(content)))
        _cors(self)
        self.end_headers()
        self.wfile.write(content)


# ════════════════════════════════════════════════════════
# ENTRY POINT
# ════════════════════════════════════════════════════════

if __name__ == "__main__":
    init_db()
    server = http.server.ThreadingHTTPServer((HOST, PORT), ChatHandler)

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "unknown"

    print("=" * 56)
    print("  LM Studio Chat — server started")
    print("=" * 56)
    print(f"  Local   :  http://localhost:{PORT}")
    print(f"  Network :  http://{local_ip}:{PORT}")
    print(f"  Database:  {Path(DB_FILE).absolute()}")
    print(f"  LM URL  :  {LM_URL}")
    print("=" * 56)
    print("  Ctrl+C to stop\n")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server stopped]")
        server.shutdown()
