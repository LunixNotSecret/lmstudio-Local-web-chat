# LM Studio Chat

A self-hosted web chat interface for [LM Studio](https://lmstudio.ai), with SQLite storage, streaming responses, file attachments, and a model guide you can fill in yourself.

---

## What it does

- Streams AI responses token by token (live token counter)
- Saves every conversation to a local SQLite database — even if you close the browser mid-response
- Works from any device on your local network
- Supports file attachments: code, text, PDF, images
- Model guide tab where you rate and describe your own models

---

## Requirements

- Python 3.8 or newer (no extra packages needed — uses only the standard library)
- [LM Studio](https://lmstudio.ai) installed and running on your machine or local network

---

## Quick start

### 1. Configure LM Studio

1. Open LM Studio
2. Go to **Local Server** (↔ icon in the sidebar)
3. Download and load a model
4. Enable **Allow CORS** in Server Settings
5. Click **Start Server**
6. Note the IP and port shown (default: `127.0.0.1:1234`)

### 2. Edit the configuration

Open **`server.py`** and set `LM_URL` to the address of your LM Studio server:

```python
# server.py — line ~20
LM_URL = "http://192.168.0.48:1234"   # ← IP of the machine running LM Studio
```

Open **`script.js`** and set `API_LM` to the same address:

```javascript
// script.js — top of file
let API_LM = "http://192.168.0.48:1234";   // ← same IP as above
```

> **Same machine?** Use `http://127.0.0.1:1234` in both files.  
> **Different machine on the same Wi-Fi?** Use its local IP (e.g. `192.168.0.48:1234`).

### 3. Start the server

```bash
cd lmstudio-chat
python server.py
```

The terminal will print:

```
Local   :  http://localhost:8000
Network :  http://192.168.0.X:8000
Database:  /path/to/conversations.db
```

Open the **Local** URL on this machine, or the **Network** URL from any other device on the same Wi-Fi.

---

## File structure

```
lmstudio-chat/
├── server.py          ← Python backend (web server + SQLite API + streaming proxy)
├── index.html         ← Page structure
├── style.css          ← Dark theme styles
├── script.js          ← All frontend logic
├── models-guide.js    ← Your personal model comparison table (edit freely)
└── conversations.db   ← Created automatically on first run (not committed to git)
```

---

## Configuration reference

| File | Variable | What to change |
|---|---|---|
| `server.py` | `LM_URL` | IP + port of the LM Studio server |
| `server.py` | `PORT` | Port this web server listens on (default 8000) |
| `script.js` | `API_LM` | Must match `LM_URL` in server.py |
| `models-guide.js` | `MODELS_GUIDE` | Fill in your own model scores and notes |

---

## Fill in the model guide

Edit `models-guide.js` to add your own ratings:

```javascript
{ name: "Mistral 7B Instruct", perf: 4, speed: 5, ram: "6 GB", note: "Great for everyday chat" },
```

- `perf` and `speed` : score from 0 (unknown) to 5 (excellent)
- `ram` : minimum VRAM or RAM required
- `note` : one-line description of the model's strengths

---

## Switching networks

If your IP changes (e.g. you move to a different Wi-Fi):

1. Update `LM_URL` in `server.py`
2. Update `API_LM` in `script.js`
3. Restart `python server.py`

Or use the **Diagnostic API** button in the sidebar to change the LM Studio URL at runtime without restarting.

---

## Clearing old conversations

The database is a single file: `conversations.db`.  
To clear everything: stop the server, delete the file, restart.  
To export first: click the download icon (↓) in the sidebar — saves a `.json` file you can re-import later.

---

## Security notes

- This server is designed for **local network use only**. Do not expose port 8000 to the internet.
- No API keys, passwords, or personal data are stored in the code.
- `conversations.db` contains your chat history — keep it private and do not commit it to git.
- The `.gitignore` below covers this.

---

## Recommended .gitignore

```
conversations.db
*.db
*.db-wal
*.db-shm
__pycache__/
*.pyc
.DS_Store
```

---

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| "server.py not running" badge | server.py not started | Run `python server.py` |
| "CORS error" in diagnostic | CORS disabled in LM Studio | Enable "Allow CORS" in LM Studio → Server Settings, restart server |
| No models in dropdown | LM Studio server not started or wrong IP | Check `LM_URL` in server.py matches LM Studio's address |
| `[object Object]` as model name | LM Studio version mismatch | Should be fixed automatically; open browser console (F12) to see raw model data |
| Response stops when browser closes | Old version without background thread | Make sure you are using the latest `server.py` — the streaming worker runs independently of the client |

---

## License

MIT — free to use, modify, and share.
