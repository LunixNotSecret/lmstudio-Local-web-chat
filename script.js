/*
 * script.js — LM Studio Chat frontend
 *
 * ════════════════════════════════════════════════════════
 * CONFIGURATION — only section that needs editing
 * ════════════════════════════════════════════════════════
 *
 * API_LM : IP address + port of the LM Studio server.
 *   Same machine  → "http://127.0.0.1:1234"
 *   Other machine → "http://192.168.0.48:1234"
 *   (must match LM_URL in server.py)
 *
 * API_DB : base URL of server.py. Leave empty ("") when
 *   opening the page served by server.py itself (same host).
 *   Change to "http://192.168.0.X:8000" only if you open
 *   index.html directly as a file (not via python server.py).
 */

"use strict";

// ════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════

let API_LM = "http://192.168.0.48:1234";   // LM Studio address — edit here
const API_DB = "";                           // server.py address — leave empty when served by server.py

const EP = {
  models    : () => `${API_LM}/api/v1/models`,
  modelLoad : () => `${API_LM}/api/v1/models/load`,
  chatStream: () => `${API_DB}/api/chat/stream`,
  convList  : ()  => `${API_DB}/api/conversations`,
  convGet   : id  => `${API_DB}/api/conversations/${id}`,
  convCreate: ()  => `${API_DB}/api/conversations`,
  convUpdate: id  => `${API_DB}/api/conversations/${id}`,
  convDelete: id  => `${API_DB}/api/conversations/${id}`,
  convSearch: q   => `${API_DB}/api/conversations/search?q=${encodeURIComponent(q)}`,
  export    : ()  => `${API_DB}/api/export`,
};

const TIMEOUT_MS = 120_000;

// ════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════

const state = {
  messages     : [],
  conversations: [],
  activeConvId : null,
  model        : "",
  modelLabel   : "",
  loadedModel  : "",
  generating   : false,
  abortCtrl    : null,
  attachments  : [],
  modelEntries : [],
  searchQuery  : "",
  liveTokens   : 0,
};

// ════════════════════════════════════════════════════════
// DOM REFS
// ════════════════════════════════════════════════════════

const $ = id => document.getElementById(id);
const dom = {
  sidebar           : $("sidebar"),
  btnToggleSidebar  : $("btnToggleSidebar"),
  btnNewChat        : $("btnNewChat"),
  modelSelect       : $("modelSelect"),
  btnRefreshModels  : $("btnRefreshModels"),
  btnLoadModel      : $("btnLoadModel"),
  modelActiveDot    : $("modelActiveDot"),
  modelActiveName   : $("modelActiveName"),
  modelStatus       : $("modelStatus"),
  paramTemp         : $("paramTemp"),
  tempVal           : $("tempVal"),
  paramMaxTokens    : $("paramMaxTokens"),
  systemPrompt      : $("systemPrompt"),
  searchInput       : $("searchInput"),
  chatHistory       : $("chatHistory"),
  apiUrlDisplay     : $("apiUrlDisplay"),
  messagesContainer : $("messagesContainer"),
  welcomeScreen     : $("welcomeScreen"),
  messagesList      : $("messagesList"),
  thinkingIndicator : $("thinkingIndicator"),
  tokenCounter      : $("tokenCounter"),
  userInput         : $("userInput"),
  btnSend           : $("btnSend"),
  btnAttach         : $("btnAttach"),
  fileInput         : $("fileInput"),
  attachmentPreview : $("attachmentPreview"),
  btnExport         : $("btnExport"),
  guideContainer    : $("guideContainer"),
  diagModal         : $("diagModal"),
  btnDiag           : $("btnDiag"),
  btnCloseDiag      : $("btnCloseDiag"),
  diagApiUrl        : $("diagApiUrl"),
  btnApplyUrl       : $("btnApplyUrl"),
  btnRunAllDiag     : $("btnRunAllDiag"),
  loadModal         : $("loadModal"),
  loadModalTitle    : $("loadModalTitle"),
  loadModalMsg      : $("loadModalMsg"),
  btnCancelLoad     : $("btnCancelLoad"),
  dbStatus          : $("dbStatus"),
};

// ════════════════════════════════════════════════════════
// INIT
// ════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();
  buildGuide();
  await checkDbConnection();
  await loadConversationList();
  await loadModelList();
  updateApiUrlDisplay();
  startNewConversation();
});

// ════════════════════════════════════════════════════════
// EVENTS
// ════════════════════════════════════════════════════════

function bindEvents() {
  dom.btnToggleSidebar.addEventListener("click", () => dom.sidebar.classList.toggle("open"));
  dom.messagesContainer.addEventListener("click", () => dom.sidebar.classList.remove("open"));
  dom.btnNewChat.addEventListener("click", () => { startNewConversation(); dom.sidebar.classList.remove("open"); });

  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
    });
  });

  dom.modelSelect.addEventListener("change", () => {
    const sel = dom.modelSelect.options[dom.modelSelect.selectedIndex];
    if (!sel) return;
    state.model      = sel.dataset.apiId || sel.value;
    state.modelLabel = sel.dataset.label || shortLabel(state.model);
    updateLoadButton();
  });
  dom.btnRefreshModels.addEventListener("click", loadModelList);
  dom.btnLoadModel.addEventListener("click", loadSelectedModel);
  dom.paramTemp.addEventListener("input", () => { dom.tempVal.textContent = dom.paramTemp.value; });

  dom.userInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendOrStop(); }
  });
  dom.userInput.addEventListener("input", () => { autoResizeTextarea(dom.userInput); updateSendButton(); });
  dom.btnSend.addEventListener("click", handleSendOrStop);

  dom.btnAttach.addEventListener("click", () => dom.fileInput.click());
  dom.fileInput.addEventListener("change", e => { processFiles([...e.target.files]); e.target.value = ""; });
  dom.userInput.addEventListener("dragover",  e => { e.preventDefault(); dom.userInput.classList.add("drag-over"); });
  dom.userInput.addEventListener("dragleave", ()  => dom.userInput.classList.remove("drag-over"));
  dom.userInput.addEventListener("drop", e => {
    e.preventDefault();
    dom.userInput.classList.remove("drag-over");
    processFiles([...e.dataTransfer.files]);
  });

  dom.searchInput.addEventListener("input", debounce(async () => {
    state.searchQuery = dom.searchInput.value.trim();
    await loadConversationList();
  }, 300));

  dom.btnExport.addEventListener("click", exportConversations);
  dom.btnDiag.addEventListener("click", openDiagModal);
  dom.btnCloseDiag.addEventListener("click", closeDiagModal);
  dom.diagModal.addEventListener("click", e => { if (e.target === dom.diagModal) closeDiagModal(); });
  dom.btnApplyUrl.addEventListener("click", applyNewApiUrl);
  dom.diagApiUrl.addEventListener("keydown", e => { if (e.key === "Enter") applyNewApiUrl(); });
  document.querySelectorAll(".btn-run[data-test]").forEach(btn =>
    btn.addEventListener("click", () => runDiagTest(Number(btn.dataset.test)))
  );
  dom.btnRunAllDiag.addEventListener("click", runAllDiagTests);
  dom.btnCancelLoad.addEventListener("click", () => dom.loadModal.classList.add("hidden"));
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeDiagModal(); dom.loadModal.classList.add("hidden"); }
  });
}

// ════════════════════════════════════════════════════════
// MODEL GUIDE TAB
// ════════════════════════════════════════════════════════

function buildGuide() {
  if (!dom.guideContainer || typeof MODELS_GUIDE === "undefined") return;

  dom.guideContainer.innerHTML = `
    <div class="guide-intro">
      <h2>🏆 Model Guide</h2>
      <p>Choose the right model for the job. Edit <code>models-guide.js</code> to fill in your own scores and notes.</p>
    </div>`;

  MODELS_GUIDE.forEach(cat => {
    const section = document.createElement("div");
    section.className = "guide-category";
    section.innerHTML = `
      <div class="guide-cat-header">
        <div class="guide-cat-dot" style="background:${cat.color}"></div>
        <span class="guide-cat-title">${cat.category}</span>
      </div>
      <table class="guide-table">
        <thead>
          <tr><th>Model</th><th>Perf</th><th>Speed</th><th>Min RAM</th><th>Note</th></tr>
        </thead>
        <tbody>
          ${cat.models.map(m => `
            <tr>
              <td><span class="model-name">${m.name}</span></td>
              <td>${stars(m.perf, cat.color)}</td>
              <td>${stars(m.speed, "#3ecf8e")}</td>
              <td><span class="model-ram">${m.ram}</span></td>
              <td><span class="model-note">${m.note}</span></td>
            </tr>`).join("")}
        </tbody>
      </table>`;
    dom.guideContainer.appendChild(section);
  });

  const note = document.createElement("div");
  note.className = "guide-note";
  note.innerHTML = `
    <strong>How to use:</strong><br>
    1. Download a model in LM Studio (Discover tab)<br>
    2. Click "Refresh" in the model selector<br>
    3. Select the model and click <strong>Load</strong><br>
    4. Fill in your own scores and notes in <code>models-guide.js</code>
  `;
  dom.guideContainer.appendChild(note);
}

function stars(n, color) {
  return `<div class="stars">${Array.from({length:5},(_,i) =>
    `<div class="star ${i<n?"on":"off"}" style="${i<n?`background:${color}`:""}"></div>`
  ).join("")}</div>`;
}

// ════════════════════════════════════════════════════════
// DATABASE CONNECTION CHECK
// ════════════════════════════════════════════════════════

async function checkDbConnection() {
  try {
    const res = await fetch(EP.convList(), { signal: AbortSignal.timeout(3000) });
    if (res.ok) { setDbStatus("✓ SQLite database connected", "ok"); return true; }
    throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    setDbStatus("✗ server.py not running — run: python server.py", "err");
    return false;
  }
}

function setDbStatus(t, cls) {
  if (dom.dbStatus) { dom.dbStatus.textContent = t; dom.dbStatus.className = `db-status ${cls}`; }
}

// ════════════════════════════════════════════════════════
// CONVERSATIONS — list / load / delete / export
// ════════════════════════════════════════════════════════

async function loadConversationList() {
  try {
    const url = state.searchQuery ? EP.convSearch(state.searchQuery) : EP.convList();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.conversations = await res.json();
    renderConversationHistory();
  } catch (err) {
    dom.chatHistory.innerHTML = `<div class="conv-error">⚠ ${err.message}</div>`;
  }
}

async function saveToDb(userText) {
  const title = (userText || state.messages[0]?.content || "Conversation").slice(0, 60);
  if (state.activeConvId) {
    await fetch(EP.convUpdate(state.activeConvId), {
      method : "PUT",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ messages: state.messages, model: state.modelLabel || state.model }),
    });
  } else {
    const res = await fetch(EP.convCreate(), {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ title, model: state.modelLabel || state.model, messages: state.messages }),
    });
    if (res.ok) { const d = await res.json(); state.activeConvId = d.id; }
  }
  await loadConversationList();
}

async function deleteConversation(convId, e) {
  e.stopPropagation();
  if (!confirm("Delete this conversation?")) return;
  await fetch(EP.convDelete(convId), { method: "DELETE" });
  if (state.activeConvId === convId) startNewConversation();
  else await loadConversationList();
}

async function loadConversation(convId) {
  try {
    const res  = await fetch(EP.convGet(convId));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const conv = await res.json();
    state.messages     = conv.messages.map(m => ({ role: m.role, content: m.content, tokens: m.tokens || 0 }));
    state.activeConvId = convId;
    dom.messagesList.innerHTML = "";
    hideWelcomeScreen();
    state.messages.forEach(msg => appendMessageToDOM(msg.role, msg.content, [], msg.tokens));
    renderConversationHistory();
    dom.sidebar.classList.remove("open");
  } catch (err) { showToast("Error loading conversation", "err"); }
}

async function exportConversations() {
  try {
    const res  = await fetch(EP.export());
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `lmchat_${new Date().toISOString().slice(0,10)}.json`;
    a.click(); URL.revokeObjectURL(url);
    showToast("Export downloaded ✓", "ok");
  } catch { showToast("Export failed", "err"); }
}

// ════════════════════════════════════════════════════════
// MODEL LIST — fetch from LM Studio
// ════════════════════════════════════════════════════════

async function loadModelList() {
  setModelStatus("Loading…", "");
  dom.modelSelect.innerHTML = '<option value="">Loading…</option>';
  dom.modelSelect.disabled = true;
  dom.btnLoadModel.disabled = true;
  try {
    const res = await fetchWithTimeout(EP.models());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    let raw = [];
    if (Array.isArray(data))            raw = data;
    else if (Array.isArray(data?.data)) raw = data.data;
    else { const f = Object.values(data).find(v => Array.isArray(v)); if (f) raw = f; }

    state.modelEntries = raw.map(parseModelEntry).filter(Boolean);

    if (!state.modelEntries.length) {
      dom.modelSelect.innerHTML = '<option value="">No models found</option>';
      setModelStatus("⚠ Download a model in LM Studio first.", "err");
      return;
    }

    const llms   = state.modelEntries.filter(m => m.type === "llm" || m.type === "chat" || m.type === "");
    const others = state.modelEntries.filter(m => m.type && m.type !== "llm" && m.type !== "chat");

    dom.modelSelect.innerHTML = "";
    if (llms.length)   { const g = document.createElement("optgroup"); g.label = "Chat models";        llms.forEach(m => g.appendChild(buildOption(m)));   dom.modelSelect.appendChild(g); }
    if (others.length) { const g = document.createElement("optgroup"); g.label = "Other (not for chat)"; others.forEach(m => g.appendChild(buildOption(m))); dom.modelSelect.appendChild(g); }

    dom.modelSelect.disabled = false;
    const pre = state.modelEntries.find(m => m.loaded) ?? llms[0] ?? state.modelEntries[0];
    dom.modelSelect.value = pre.apiId;
    state.model      = pre.apiId;
    state.modelLabel = pre.label;
    if (pre.loaded) { state.loadedModel = pre.apiId; setActiveModel(pre.apiId, pre.label); }
    updateLoadButton();
    setModelStatus(`✓ ${state.modelEntries.length} model(s)`, "ok");
    updateSendButton();
  } catch (err) {
    dom.modelSelect.innerHTML = '<option value="">Connection error</option>';
    if (isCorsError(err)) setModelStatus("✗ CORS error — enable CORS in LM Studio", "err");
    else setModelStatus(`✗ ${err.message}`, "err");
  }
}

// ════════════════════════════════════════════════════════
// MODEL ENTRY PARSING — handles all LM Studio JSON formats
// ════════════════════════════════════════════════════════

function parseModelEntry(raw) {
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return parseInnerObject(JSON.parse(raw)); } catch { return { apiId:raw, label:shortLabel(raw), type:"", loaded:false }; }
  }
  if (typeof raw !== "object") return null;
  if (typeof raw.id === "string" && raw.id.trimStart().startsWith("{")) {
    try { return parseInnerObject(JSON.parse(raw.id)); } catch {}
  }
  if (raw.type !== undefined || raw.key !== undefined || raw.path !== undefined) return parseInnerObject(raw);
  if (typeof raw.id === "string") return { apiId:raw.id, label:shortLabel(raw.id), type:"", loaded:false };
  return null;
}

function parseInnerObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  const apiId =
    obj.selected_variant ??
    (Array.isArray(obj.variants) && obj.variants[0]) ??
    obj.key ?? obj.path ?? obj.id ?? null;
  if (!apiId) return null;
  const label  = obj.display_name ?? obj.id ?? shortLabel(obj.key ?? obj.path ?? apiId);
  const type   = (obj.type ?? "").toLowerCase();
  const loaded = Array.isArray(obj.loaded_instances) && obj.loaded_instances.length > 0;
  return { apiId, label, type, loaded };
}

function buildOption(m) {
  const opt = document.createElement("option");
  opt.value = m.apiId; opt.dataset.apiId = m.apiId; opt.dataset.label = m.label; opt.title = m.apiId;
  opt.textContent = (m.loaded ? "● " : "○ ") + m.label;
  if (m.loaded) opt.style.color = "var(--green)";
  return opt;
}

function shortLabel(s) {
  if (!s) return "?";
  const f = s.replace(/\\/g, "/").split("/").pop() ?? s;
  return f.replace(/\.(gguf|bin|safetensors|pt)$/i, "");
}

// ════════════════════════════════════════════════════════
// LOAD A MODEL via LM Studio API
// ════════════════════════════════════════════════════════

async function loadSelectedModel() {
  const sel = dom.modelSelect.options[dom.modelSelect.selectedIndex];
  if (!sel) return;
  const apiId = sel.dataset.apiId || sel.value;
  const label = sel.dataset.label || shortLabel(apiId);
  if (apiId === state.loadedModel) { showToast(`"${label}" already active`, "ok"); return; }

  dom.loadModalTitle.textContent = `Loading ${label}…`;
  dom.loadModalMsg.textContent   = `ID: ${apiId}\nThis may take a moment.`;
  dom.loadModal.classList.remove("hidden");
  dom.btnLoadModel.classList.add("loading");
  dom.btnLoadModel.textContent = "Loading…";
  setActiveDot("loading");

  try {
    const res  = await fetchWithTimeout(EP.modelLoad(), {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ identifier: apiId }),
    }, 300_000);
    const text = await res.text().catch(() => "");
    dom.loadModal.classList.add("hidden");
    dom.btnLoadModel.classList.remove("loading");

    if (!res.ok && res.status !== 200) {
      if (res.status === 400 && text.toLowerCase().includes("already")) {
        setActiveModel(apiId, label); showToast(`"${label}" already loaded ✓`, "ok");
      } else {
        setActiveDot("off"); dom.btnLoadModel.textContent = "Load";
        showToast(`Load error: HTTP ${res.status}`, "err");
      }
      return;
    }
    setActiveModel(apiId, label);
    showToast(`"${label}" ready ✓`, "ok");
    refreshSelectOptions();
  } catch (err) {
    dom.loadModal.classList.add("hidden");
    dom.btnLoadModel.classList.remove("loading");
    dom.btnLoadModel.textContent = "Load";
    setActiveDot("off");
    showToast(err.name === "AbortError" ? "Load timeout" : `Error: ${err.message}`, "err");
  }
}

function setActiveModel(apiId, label) {
  state.model = apiId; state.modelLabel = label; state.loadedModel = apiId;
  dom.modelActiveName.textContent = label; setActiveDot("on");
  dom.btnLoadModel.textContent = "Active ✓";
  dom.btnLoadModel.classList.remove("loading"); dom.btnLoadModel.classList.add("loaded");
  updateSendButton();
}
function updateLoadButton() {
  const sel = dom.modelSelect.options[dom.modelSelect.selectedIndex]; if (!sel) return;
  const apiId = sel.dataset.apiId || sel.value;
  if (apiId === state.loadedModel && state.loadedModel) {
    dom.btnLoadModel.textContent = "Active ✓"; dom.btnLoadModel.classList.add("loaded"); dom.btnLoadModel.classList.remove("loading");
  } else {
    dom.btnLoadModel.textContent = "Load"; dom.btnLoadModel.classList.remove("loaded", "loading");
  }
  dom.btnLoadModel.disabled = !apiId;
}
function setActiveDot(s) {
  dom.modelActiveDot.className = "model-active-dot";
  if (s === "on")      dom.modelActiveDot.classList.add("on");
  if (s === "loading") dom.modelActiveDot.classList.add("loading");
  if (s === "off")     dom.modelActiveName.textContent = "No active model";
}
function refreshSelectOptions() {
  Array.from(dom.modelSelect.options).forEach(opt => {
    const apiId = opt.dataset.apiId || opt.value;
    const label = opt.dataset.label || opt.textContent.replace(/^[●○] /, "");
    if (!apiId) return;
    opt.textContent = (apiId === state.loadedModel ? "● " : "○ ") + label;
    opt.style.color = apiId === state.loadedModel ? "var(--green)" : "";
  });
}

// ════════════════════════════════════════════════════════
// FILE ATTACHMENTS
// ════════════════════════════════════════════════════════

const TEXT_EXT = new Set(["txt","md","js","ts","jsx","tsx","py","java","c","cpp","cs","go","rs","php","rb","sh","bash","zsh","sql","json","yaml","yml","toml","xml","html","css","scss","vue","svelte","kt","swift","r","lua","dart"]);
const IMG_EXT  = new Set(["png","jpg","jpeg","gif","webp","svg","bmp"]);

function processFiles(files) {
  files.forEach(file => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (TEXT_EXT.has(ext) || file.type.startsWith("text/")) {
      const r = new FileReader(); r.onload = ev => addAttachment({ name:file.name, type:"text", content:ev.target.result, ext }); r.readAsText(file);
    } else if (IMG_EXT.has(ext) || file.type.startsWith("image/")) {
      const r = new FileReader(); r.onload = ev => addAttachment({ name:file.name, type:"image", content:ev.target.result, ext }); r.readAsDataURL(file);
    } else if (ext === "pdf" || file.type === "application/pdf") {
      const r = new FileReader();
      r.onload = ev => {
        const chunks = []; const re = /\(([^)]{1,500})\)\s*Tj/g; let m;
        while ((m = re.exec(ev.target.result)) !== null) { const t = m[1].replace(/\\n/g,"\n"); if (t.trim()) chunks.push(t); }
        addAttachment({ name:file.name, type:"text", content:chunks.length ? chunks.join(" ") : `[${file.name} — scanned PDF, paste text manually]`, ext:"pdf" });
      };
      r.readAsText(file, "latin1");
    } else { showToast(`Unsupported type: .${ext}`, "err"); }
  });
}

function addAttachment(att)  { state.attachments.push(att); renderAttachmentPreview(); updateSendButton(); }
function removeAttachment(i) { state.attachments.splice(i, 1); renderAttachmentPreview(); updateSendButton(); }

function renderAttachmentPreview() {
  if (!state.attachments.length) { dom.attachmentPreview.classList.add("hidden"); dom.attachmentPreview.innerHTML = ""; return; }
  dom.attachmentPreview.classList.remove("hidden"); dom.attachmentPreview.innerHTML = "";
  state.attachments.forEach((att, i) => {
    const chip = document.createElement("div"); chip.className = "attachment-chip";
    const icon  = att.type === "image" ? "🖼️" : att.ext === "pdf" ? "📄" : "📎";
    const lines = att.type === "text" ? ` · ${att.content.split("\n").length} lines` : "";
    chip.innerHTML = `<span class="att-icon">${icon}</span><span class="att-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}${lines}</span><button class="att-remove" title="Remove">✕</button>`;
    if (att.type === "image") { const img = document.createElement("img"); img.src = att.content; img.className = "att-img-preview"; chip.appendChild(img); }
    chip.querySelector(".att-remove").addEventListener("click", () => removeAttachment(i));
    dom.attachmentPreview.appendChild(chip);
  });
}

function buildUserContent(text) {
  if (!state.attachments.length) return text;
  return [text, ...state.attachments.map(a =>
    a.type === "text"
      ? `\n\n--- Attached file: ${a.name} ---\n\`\`\`${a.ext}\n${a.content}\n\`\`\``
      : `\n\n[Image: ${a.name}]`
  )].join("");
}

// ════════════════════════════════════════════════════════
// SEND MESSAGE — SSE streaming through server.py
// ════════════════════════════════════════════════════════

function handleSendOrStop() {
  if (state.generating) { state.abortCtrl?.abort(); return; }
  const text = dom.userInput.value.trim();
  if (!text && !state.attachments.length) return;
  if (!state.model) { showToast("Load a model first", "err"); return; }
  sendMessage(text);
}

async function sendMessage(userText) {
  const fullContent    = buildUserContent(userText || "(see attached file)");
  const attachSnapshot = [...state.attachments];
  state.attachments = []; renderAttachmentPreview();

  state.messages.push({ role:"user", content:fullContent, tokens:0 });
  appendMessageToDOM("user", userText, attachSnapshot, 0);
  dom.userInput.value = ""; autoResizeTextarea(dom.userInput);
  hideWelcomeScreen();

  const systemMsg = dom.systemPrompt.value.trim();
  const history   = systemMsg
    ? [{ role:"system", content:systemMsg }, ...state.messages]
    : [...state.messages];

  const payload = {
    model      : String(state.model).trim(),
    messages   : history,
    temperature: parseFloat(dom.paramTemp.value),
    max_tokens : parseInt(dom.paramMaxTokens.value, 10),
    // Private fields consumed by server.py, stripped before forwarding to LM Studio
    _conv_id   : state.activeConvId,
    _user_msg  : fullContent,
    _conv_title: (userText || attachSnapshot[0]?.name || "Message").slice(0, 60),
  };

  setGenerating(true);
  state.liveTokens = 0;
  updateTokenCounter(0);

  const aiRow  = createAiPlaceholder();
  const aiBody = aiRow.querySelector(".message-body");
  let   fullText = "";

  try {
    state.abortCtrl = new AbortController();
    const res = await fetch(EP.chatStream(), {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
      signal : state.abortCtrl.signal,
    });

    if (!res.ok) { const t = await res.text().catch(()=>""); throw new Error(`HTTP ${res.status} — ${t || res.statusText}`); }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let   buffer  = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream:true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";

      for (const line of lines) {
        const l = line.trim();
        if (!l || l === "data: [DONE]") continue;
        if (!l.startsWith("data: ")) continue;
        try {
          const piece = JSON.parse(l.slice(6))?.choices?.[0]?.delta?.content ?? "";
          if (piece) {
            fullText += piece;
            state.liveTokens += Math.ceil(piece.length / 4);
            updateTokenCounter(state.liveTokens);
            aiBody.innerHTML = renderMarkdown(fullText);
            scrollToBottom();
          }
        } catch {}
      }
    }

    aiBody.innerHTML = renderMarkdown(fullText);
    addCopyButtons(aiBody); highlightCode(aiBody);
    addTokenBadge(aiRow, state.liveTokens);

    state.messages.push({ role:"assistant", content:fullText, tokens:state.liveTokens });
    await loadConversationList();
    if (!state.activeConvId && state.conversations.length) {
      state.activeConvId = state.conversations[0].id;
    }

  } catch (err) {
    if (err.name === "AbortError") {
      state.messages.pop();
      aiBody.innerHTML += '<em style="color:var(--text-muted)"> [stopped]</em>';
      if (fullText.trim()) {
        state.messages.push({ role:"assistant", content:fullText+" [stopped]", tokens:state.liveTokens });
        await saveToDb(userText);
      }
    } else {
      aiRow.remove();
      appendErrorToDOM(formatErrorMessage(err));
    }
  } finally {
    setGenerating(false); dom.userInput.focus();
  }
}

// ════════════════════════════════════════════════════════
// MESSAGE RENDERING
// ════════════════════════════════════════════════════════

function createAiPlaceholder() {
  const row   = document.createElement("div"); row.className = "message-row ai";
  const av    = document.createElement("div"); av.className = "avatar avatar-ai"; av.textContent = "AI";
  const wrap  = document.createElement("div"); wrap.className = "message-content-wrap";
  const rl    = document.createElement("div"); rl.className = "message-role"; rl.textContent = state.modelLabel || "Assistant";
  const body  = document.createElement("div"); body.className = "message-body"; body.innerHTML = '<span class="streaming-cursor">▌</span>';
  wrap.appendChild(rl); wrap.appendChild(body); row.appendChild(av); row.appendChild(wrap);
  dom.messagesList.appendChild(row); scrollToBottom();
  return row;
}

function addTokenBadge(row, tokens) {
  const wrap  = row.querySelector(".message-content-wrap");
  const badge = document.createElement("div"); badge.className = "msg-token-badge";
  badge.innerHTML = `<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/></svg> ~${tokens} tokens`;
  wrap.appendChild(badge);
}

function updateTokenCounter(n) {
  if (dom.tokenCounter) dom.tokenCounter.textContent = `~${n} tokens`;
}

function appendMessageToDOM(role, text, attachments=[], tokens=0) {
  const isAI  = role === "ai" || role === "assistant";
  const row   = document.createElement("div"); row.className = `message-row ${isAI?"ai":"user"}`;
  const av    = document.createElement("div"); av.className  = `avatar avatar-${isAI?"ai":"user"}`; av.textContent = isAI ? "AI" : "Vo";
  const wrap  = document.createElement("div"); wrap.className = "message-content-wrap";
  const rl    = document.createElement("div"); rl.className  = "message-role"; rl.textContent = isAI ? (state.modelLabel||"Assistant") : "You";
  const body  = document.createElement("div"); body.className = "message-body";

  if (isAI) {
    body.innerHTML = renderMarkdown(text); addCopyButtons(body); highlightCode(body);
  } else {
    if (text) { const d = document.createElement("div"); d.style.whiteSpace = "pre-wrap"; d.textContent = text; body.appendChild(d); }
    attachments.forEach(att => {
      const chip = document.createElement("div"); chip.className = "attachment-chip msg-att";
      const icon = att.type === "image" ? "🖼️" : att.ext === "pdf" ? "📄" : "📎";
      chip.innerHTML = `<span>${icon} ${escapeHtml(att.name)}</span>`;
      if (att.type === "image") { const img = document.createElement("img"); img.src = att.content; img.className = "att-img-preview"; chip.appendChild(img); }
      body.appendChild(chip);
    });
  }

  const actions = document.createElement("div"); actions.className = "message-actions";
  actions.appendChild(createActionButton("Copy", copyIcon(), () => navigator.clipboard.writeText(text).then(() => showToast("Copied!", "ok"))));
  wrap.appendChild(rl); wrap.appendChild(body);
  if (isAI && tokens > 0) addTokenBadge(row, tokens);
  wrap.appendChild(actions); row.appendChild(av); row.appendChild(wrap);
  dom.messagesList.appendChild(row); scrollToBottom();
}

function appendErrorToDOM(msg) {
  const row = document.createElement("div"); row.className = "message-row ai"; row.style.cssText = "border-left:3px solid var(--red)";
  row.innerHTML = `<div class="avatar avatar-ai" style="background:var(--red)">!</div><div class="message-content-wrap"><div class="message-role" style="color:var(--red)">Error</div><div class="message-body" style="color:var(--red);white-space:pre-wrap">${escapeHtml(msg)}</div></div>`;
  dom.messagesList.appendChild(row); scrollToBottom();
}

function extractAssistantText(data) {
  if (data?.choices?.[0]?.message?.content !== undefined) return data.choices[0].message.content;
  if (data?.choices?.[0]?.text             !== undefined) return data.choices[0].text;
  if (data?.message?.content               !== undefined) return data.message.content;
  if (typeof data?.content  === "string")                 return data.content;
  if (typeof data?.response === "string")                 return data.response;
  if (typeof data?.text     === "string")                 return data.text;
  return null;
}

// ════════════════════════════════════════════════════════
// CONVERSATION UI
// ════════════════════════════════════════════════════════

function startNewConversation() {
  state.messages = []; state.attachments = []; state.activeConvId = null;
  dom.messagesList.innerHTML = ""; dom.welcomeScreen.classList.remove("hidden");
  dom.userInput.disabled = false;
  renderAttachmentPreview(); updateSendButton(); renderConversationHistory(); dom.userInput.focus();
}

function renderConversationHistory() {
  dom.chatHistory.innerHTML = "";
  if (!state.conversations.length) {
    dom.chatHistory.innerHTML = `<div style="font-size:11px;color:var(--text-muted);padding:4px 0">${state.searchQuery ? "No results" : "No conversations yet"}</div>`;
    return;
  }
  state.conversations.forEach(conv => {
    const item = document.createElement("div");
    item.className = "history-item" + (conv.id === state.activeConvId ? " active" : "");
    const date = conv.updated_at ? new Date(conv.updated_at).toLocaleDateString("en-GB", {day:"2-digit",month:"2-digit"}) : "";
    const lbl  = document.createElement("span"); lbl.className = "history-label"; lbl.textContent = conv.title; lbl.title = conv.title;
    const meta = document.createElement("span"); meta.className = "history-meta"; meta.textContent = date;
    const del  = document.createElement("button"); del.className = "history-del"; del.title = "Delete"; del.textContent = "✕";
    del.addEventListener("click", e => deleteConversation(conv.id, e));
    item.appendChild(lbl); item.appendChild(meta); item.appendChild(del);
    item.addEventListener("click", () => loadConversation(conv.id));
    dom.chatHistory.appendChild(item);
  });
}

// ════════════════════════════════════════════════════════
// DIAGNOSTICS
// ════════════════════════════════════════════════════════

function openDiagModal()  { dom.diagModal.classList.remove("hidden"); dom.diagApiUrl.value = API_LM; }
function closeDiagModal() { dom.diagModal.classList.add("hidden"); }

function applyNewApiUrl() {
  const raw = dom.diagApiUrl.value.trim().replace(/\/$/, ""); if (!raw) return;
  API_LM = raw; updateApiUrlDisplay(); showToast(`LM Studio URL → ${API_LM}`, "ok"); loadModelList();
}

async function runDiagTest(n) {
  const badge  = document.querySelector(`#diagTest${n} .diag-badge`);
  const result = $(`diagResult${n}`);
  setBadge(badge, "running"); result.className = "diag-result"; result.textContent = "Running…";
  try {
    if (n === 1) await diagTestModels(badge, result);
    if (n === 2) await diagTestChat(badge, result);
    if (n === 3) await diagTestCors(badge, result);
  } catch (err) { setBadge(badge,"err"); result.className="diag-result err"; result.textContent=`ERROR\n${err.message}`; }
}
async function runAllDiagTests() { for (let i=1;i<=3;i++) { await runDiagTest(i); await sleep(300); } }

async function diagTestModels(badge, result) {
  const t0 = performance.now(); const res = await fetchWithTimeout(EP.models(),{},10_000); const ms = Math.round(performance.now()-t0);
  const raw = await res.text(); let p; try { p = JSON.parse(raw); } catch { p = raw; }
  if (!res.ok) { setBadge(badge,"err"); result.className="diag-result err"; result.textContent=`HTTP ${res.status}\n${raw}`; return; }
  const count = Array.isArray(p?.data??p) ? (p?.data??p).length : "?";
  setBadge(badge,"ok"); result.className="diag-result ok";
  result.textContent = `✓ HTTP ${res.status} — ${ms}ms\n✓ ${count} model(s)\n\n${JSON.stringify(p,null,2).slice(0,800)}`;
}
async function diagTestChat(badge, result) {
  if (!state.model) { setBadge(badge,"err"); result.className="diag-result err"; result.textContent="✗ No model loaded."; return; }
  const payload = { model:state.model, messages:[{role:"user",content:"Reply just: OK"}], temperature:0, max_tokens:10, stream:false };
  const t0 = performance.now();
  let res = await fetchWithTimeout(`${API_LM}/api/v1/chat`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)},30_000);
  let ep  = "/api/v1/chat";
  if (res.status===400||res.status===404) { res=await fetchWithTimeout(`${API_LM}/v1/chat/completions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)},30_000); ep="/v1/chat/completions"; }
  const ms = Math.round(performance.now()-t0); const raw = await res.text(); let p; try{p=JSON.parse(raw);}catch{p=null;}
  if (!res.ok) { setBadge(badge,"err"); result.className="diag-result err"; result.textContent=`HTTP ${res.status} — ${ms}ms\n${raw}`; return; }
  const text = p ? (extractAssistantText(p)??"?") : raw;
  setBadge(badge,"ok"); result.className="diag-result ok";
  result.textContent = `✓ HTTP ${res.status} — ${ms}ms\n✓ Endpoint: ${ep}\n✓ Reply: "${text.trim()}"\n\n${JSON.stringify(p,null,2).slice(0,600)}`;
}
async function diagTestCors(badge, result) {
  try {
    const res = await fetchWithTimeout(EP.models(),{method:"GET",mode:"cors"},10_000);
    const h   = res.headers.get("access-control-allow-origin");
    if (h) { setBadge(badge,"ok"); result.className="diag-result ok"; result.textContent=`✓ CORS active\nAccess-Control-Allow-Origin: ${h}`; }
    else   { setBadge(badge,"err"); result.className="diag-result err"; result.textContent="⚠ CORS header missing\nEnable CORS in LM Studio → Server Settings"; }
  } catch (err) {
    setBadge(badge,"err"); result.className="diag-result err";
    result.textContent = isCorsError(err)
      ? `✗ CORS BLOCKED\n1. LM Studio → Server Settings\n2. Enable "Allow CORS"\n3. Restart server\n\n${err.message}`
      : `✗ ${err.name}: ${err.message}`;
  }
}

// ════════════════════════════════════════════════════════
// UI HELPERS
// ════════════════════════════════════════════════════════

function setGenerating(active) {
  state.generating = active;
  dom.thinkingIndicator.classList.toggle("hidden", !active);
  dom.userInput.disabled = active;
  if (active) { dom.btnSend.classList.add("stop"); dom.btnSend.disabled=false; dom.btnSend.title="Stop"; dom.btnSend.innerHTML=stopIcon(); }
  else        { dom.btnSend.classList.remove("stop"); dom.btnSend.innerHTML=sendIcon(); dom.btnSend.title="Send"; updateSendButton(); }
  scrollToBottom();
}
function updateSendButton()     { const ok=!!state.model&&(dom.userInput.value.trim().length>0||state.attachments.length>0); dom.btnSend.disabled=!ok&&!state.generating; }
function setModelStatus(t, cls) { dom.modelStatus.textContent=t; dom.modelStatus.className=`model-status ${cls}`; }
function hideWelcomeScreen()    { dom.welcomeScreen.classList.add("hidden"); }
function scrollToBottom()       { requestAnimationFrame(()=>{ dom.messagesContainer.scrollTop=dom.messagesContainer.scrollHeight; }); }
function autoResizeTextarea(el) { el.style.height="auto"; el.style.height=Math.min(el.scrollHeight,180)+"px"; }
function updateApiUrlDisplay()  { if(dom.apiUrlDisplay) dom.apiUrlDisplay.textContent=API_LM; }
function setBadge(el, s)        { el.dataset.status=s; }
function showToast(msg, type="") { const t=document.createElement("div"); t.className=`toast ${type}`; t.textContent=msg; document.body.appendChild(t); setTimeout(()=>t.remove(),3000); }
function createActionButton(label,iconHtml,onClick) { const b=document.createElement("button"); b.className="btn-msg-action"; b.innerHTML=`${iconHtml} ${label}`; b.addEventListener("click",onClick); return b; }
function debounce(fn,delay) { let t; return(...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),delay); }; }

// ════════════════════════════════════════════════════════
// MARKDOWN + SYNTAX HIGHLIGHT
// ════════════════════════════════════════════════════════

function renderMarkdown(text) {
  if (typeof marked==="undefined") return `<p>${escapeHtml(text).replace(/\n/g,"<br>")}</p>`;
  marked.setOptions({breaks:true,gfm:true,pedantic:false}); return marked.parse(text);
}
function addCopyButtons(c) {
  c.querySelectorAll("pre").forEach(pre => {
    const btn=document.createElement("button"); btn.className="copy-code-btn"; btn.textContent="Copy"; pre.style.position="relative"; pre.appendChild(btn);
    btn.addEventListener("click",()=>{ const code=pre.querySelector("code")?.textContent??pre.textContent; navigator.clipboard.writeText(code).then(()=>{ btn.textContent="✓ Copied"; btn.classList.add("copied"); setTimeout(()=>{btn.textContent="Copy";btn.classList.remove("copied");},2000); }); });
  });
}
function highlightCode(c) { if(typeof hljs!=="undefined") c.querySelectorAll("pre code").forEach(b=>hljs.highlightElement(b)); }

// ════════════════════════════════════════════════════════
// NETWORK
// ════════════════════════════════════════════════════════

async function fetchWithTimeout(url, options={}, timeout=TIMEOUT_MS) {
  const ctrl=new AbortController(); const id=setTimeout(()=>ctrl.abort(),timeout);
  try { return await fetch(url,{...options,signal:ctrl.signal}); } finally { clearTimeout(id); }
}
function isCorsError(err) {
  if (!err) return false;
  const msg=(err.message??"").toLowerCase();
  return err.name==="TypeError"&&(msg.includes("failed to fetch")||msg.includes("network request failed")||msg.includes("load failed")||msg.includes("cors"));
}
function formatErrorMessage(err) {
  if (isCorsError(err))       return "CORS error — enable CORS in LM Studio (Server → Allow CORS).";
  if (err.name==="AbortError") return "Request cancelled.";
  return `Error: ${err.message}`;
}

// ════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════

function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#039;"); }
function sleep(ms)     { return new Promise(r=>setTimeout(r,ms)); }
function sendIcon()    { return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 2L11 13"/><path d="M22 2L15 22 11 13 2 9l20-7z"/></svg>`; }
function stopIcon()    { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>`; }
function copyIcon()    { return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`; }
