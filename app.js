(() => {
  const $ = (id) => document.getElementById(id);
  const status = (el, msg) => { el.textContent = msg || ""; };
  const validConfig = () =>
    window.SUPABASE_URL && !window.SUPABASE_URL.includes("YOUR-PROJECT") &&
    window.SUPABASE_ANON_KEY && !window.SUPABASE_ANON_KEY.includes("YOUR_");

  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    remove(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
  };

  // <pure> ---- helpers with no DOM access (unit-testable) ----
  const RICH_RE = /(`[^`\n]+`)|((?:https?:\/\/|www\.)[^\s<]+)|(\*[^*\n]+\*)|(_[^_\n]+_)/g;

  // Splits text into plain text / link / bold / italic / code tokens.
  function tokenizeRich(text) {
    const out = [];
    let last = 0, m;
    const pushText = (t) => {
      if (!t) return;
      const prev = out[out.length - 1];
      if (prev && prev.type === "text") prev.text += t; else out.push({ type: "text", text: t });
    };
    const wordy = (c) => !!c && /[\p{L}\p{N}]/u.test(c);
    RICH_RE.lastIndex = 0;
    while ((m = RICH_RE.exec(text))) {
      const start = m.index, end = start + m[0].length;
      pushText(text.slice(last, start));
      if (m[1]) {
        out.push({ type: "code", text: m[1].slice(1, -1) });
      } else if (m[2]) {
        let url = m[2], trail = "";
        const tm = /[.,!?;:)\]}'"]+$/.exec(url);
        if (tm) { trail = tm[0]; url = url.slice(0, -trail.length); }
        if (/^(https?:\/\/|www\.)./i.test(url)) {
          out.push({ type: "link", text: url, href: /^https?:\/\//i.test(url) ? url : "https://" + url });
        } else pushText(url);
        pushText(trail);
      } else {
        // bold / italic only when not glued to letters or digits (keeps snake_case_words intact)
        if (wordy(text[start - 1]) || wordy(text[end])) pushText(m[0]);
        else out.push({ type: m[3] ? "bold" : "italic", text: m[0].slice(1, -1) });
      }
      last = end;
    }
    pushText(text.slice(last));
    return out;
  }

  // Replies are stored as plain text:  "> Name: quoted text\nreply"
  function parseReply(content) {
    const m = /^> (.{1,40}?): (.*)\n([\s\S]*)$/.exec(content || "");
    return m ? { quoteName: m[1], quoteText: m[2], body: m[3] } : { body: content || "" };
  }

  function oneLine(t, n) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  let EMOJI_ONLY = null, EMOJI_ANY = null;
  try {
    EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|\u200d|\ufe0f|\s)+$/u;
    EMOJI_ANY = /\p{Extended_Pictographic}|\p{Regional_Indicator}/gu;
  } catch { /* old browser: no big emoji */ }
  function isBigEmoji(body) {
    if (!EMOJI_ONLY) return false;
    const t = String(body || "").trim();
    if (!t || !EMOJI_ONLY.test(t)) return false;
    const n = (t.match(EMOJI_ANY) || []).length;
    return n > 0 && n <= 5;
  }
  // </pure>

  let client, currentRoom = null, currentRoomName = "", currentUsername = "", channel = null, presenceChannel = null,
      currentUserId = null, presenceKey = null, activeNames = new Set(), activeMembers = [], presenceReady = false,
      joinNoticeShown = false;

  // message paging / layout tracking
  const PAGE = 100;
  const COLS = "id, room_id, username, content, created_at";
  const GROUP_MS = 5 * 60 * 1000;
  const layout = { dayKey: null, sender: null, time: 0, bubble: null };
  let oldestCreatedAt = null, newestCreatedAt = "1970-01-01T00:00:00+00:00";
  let hasMore = false, loadingOlder = false, pendingNew = 0;

  // typing indicator
  const typers = new Map();
  let lastTypingSent = 0, typingIdleTimer = null;

  // alerts (sound / unread count / pop-ups)
  const baseTitle = document.title;
  let unread = 0, audioCtx = null;
  let notifyMode = store.get("vc_notify_mode", "sound");
  if (!["sound", "silent", "mute"].includes(notifyMode)) notifyMode = "sound";

  // reply + connection state
  let replyTo = null;
  let retryTimer = null, retryCount = 0, reconnecting = false, wasDown = false;
  let draftTimer = null;

  const entryCard = $("entry-card"), chatCard = $("chat-card");
  const createForm = $("create-form"), joinForm = $("join-form");

  if (validConfig() && window.supabase) {
    client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  } else {
    status($("entry-status"), "Setup required: add your Supabase URL and anon key in config.js.");
  }

  // ================= Injected styles (no CSS file changes needed) =================
  (function injectStyles() {
    const st = document.createElement("style");
    st.id = "vc-extra-style";
    st.textContent = `
      .msg-dot { display: none; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.25); margin-right: 6px; vertical-align: middle; flex: none; }
      .msg-dot.on { display: inline-block; }

      .header-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
      .icon-btn { padding: 9px 11px; line-height: 1; font-size: 14px; }

      .date-sep { align-self: center; width: 100%; display: flex; align-items: center; gap: 10px; color: #94a3b8; font-size: 11px; font-weight: 600; margin: 4px 0; }
      .date-sep::before, .date-sep::after { content: ""; flex: 1; height: 1px; background: rgba(148,163,184,.25); }

      .message.grouped { margin-top: -9px; }
      .message .bubble.no-tail { border-radius: 15px !important; }

      .bubble a { color: #93c5fd; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
      .message.mine .bubble a { color: #fff; }
      .bubble code { background: rgba(0,0,0,.3); padding: 1px 6px; border-radius: 6px; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; }
      .bubble.big-emoji { background: none !important; border-color: transparent !important; font-size: 34px; line-height: 1.25; padding: 0 4px; }

      .reply-quote { display: flex; flex-direction: column; gap: 2px; margin-bottom: 6px; padding: 5px 8px; border-left: 3px solid #a78bfa; background: rgba(0,0,0,.22); border-radius: 6px; font-size: 12px; white-space: normal; }
      .reply-quote strong { font-size: 11px; color: #c4b5fd; }
      .reply-quote span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; opacity: .9; }

      .msg-actions { display: flex; gap: 6px; margin: 5px 7px 0; }
      .message.mine .msg-actions { justify-content: flex-end; }
      .msg-actions button { border: 1px solid rgba(148,163,184,.35); background: rgba(30,41,59,.9); color: #cbd5e1; border-radius: 999px; padding: 5px 11px; font-size: 11px; cursor: pointer; }

      .message.search-hit .bubble { box-shadow: 0 0 0 2px rgba(251,191,36,.55); }
      .message.search-current .bubble { box-shadow: 0 0 0 3px #f59e0b; }

      .load-more { align-self: center; border: 1px solid #334155; background: #1e293b; color: #cbd5e1; border-radius: 999px; padding: 7px 14px; font-size: 12px; cursor: pointer; }
      .load-more:disabled { opacity: .6; cursor: wait; }

      #chat-toolbar { flex: none; display: flex; gap: 8px; padding: 8px 16px; border-bottom: 1px solid #263244; overflow-x: auto; }
      .chip { padding: 7px 11px; font-size: 12px; white-space: nowrap; display: inline-flex; align-items: center; }
      #search-bar { flex: none; display: flex; align-items: center; gap: 6px; padding: 8px 16px; border-bottom: 1px solid #263244; }
      #search-bar input { flex: 1; min-width: 0; padding: 9px 12px; font-size: 13px; border-radius: 10px; }
      #search-count { font-size: 11px; color: #94a3b8; min-width: 44px; text-align: center; }
      #conn-bar { flex: none; padding: 6px 16px; font-size: 12px; text-align: center; }
      #conn-bar[data-state="offline"] { background: #7f1d1d; color: #fecaca; }
      #conn-bar[data-state="retry"] { background: #78350f; color: #fde68a; }

      #reply-bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 7px 18px; border-top: 1px solid #263244; font-size: 12px; color: #94a3b8; }
      #reply-bar .rb-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #reply-bar strong { color: #a78bfa; margin-right: 6px; }
      #reply-bar button { background: transparent; border: 0; color: inherit; font-size: 16px; cursor: pointer; padding: 2px 6px; }

      #online-pop { position: absolute; z-index: 20; left: 16px; min-width: 190px; max-width: 80%; max-height: 50%; overflow-y: auto; background: #1e293b; border: 1px solid #475569; border-radius: 13px; padding: 10px 12px; box-shadow: 0 12px 35px rgba(0,0,0,.5); font-size: 13px; }
      #online-pop .op-title { font-size: 11px; color: #94a3b8; font-weight: 700; letter-spacing: .5px; margin-bottom: 8px; }
      #online-pop .op-item { display: flex; align-items: center; gap: 2px; padding: 4px 0; }
      #online-pop .op-you { opacity: .6; font-size: 12px; margin-left: 6px; }

      #jump-btn { position: absolute; left: 50%; transform: translateX(-50%); z-index: 15; border: 0; border-radius: 999px; padding: 8px 14px; background: #7c3aed; color: #fff; font-size: 12px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,.35); cursor: pointer; }

      #typing-indicator { flex: none; min-height: 22px; padding: 0 22px 4px; font-size: 11px; color: #94a3b8; display: flex; align-items: center; gap: 7px; }
      .typing-dots { display: inline-flex; gap: 3px; }
      .typing-dots i { width: 5px; height: 5px; border-radius: 50%; background: currentColor; opacity: .35; animation: vcBlink 1.2s infinite; }
      .typing-dots i:nth-child(2) { animation-delay: .2s; }
      .typing-dots i:nth-child(3) { animation-delay: .4s; }
      @keyframes vcBlink { 0%, 80%, 100% { opacity: .25; } 40% { opacity: 1; } }

      #vc-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: #111827; color: #fff; padding: 10px 16px; border-radius: 999px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 9999; max-width: 90vw; text-align: center; border: 1px solid rgba(255,255,255,.18); }
      #vc-toast.show { opacity: 1; }

      /* ---------- Light theme ---------- */
      html[data-theme="light"] { color: #0f172a; }
      html[data-theme="light"] body { color: #0f172a; background: radial-gradient(ellipse at 15% 10%, #dbeafe 0, transparent 42%), radial-gradient(ellipse at 90% 90%, #ede9fe 0, transparent 38%), #f1f5f9; }
      html[data-theme="light"] .card, html[data-theme="light"] .chat-card { background: rgba(255,255,255,.96); border-color: #e2e8f0; box-shadow: 0 20px 60px rgba(15,23,42,.15); }
      html[data-theme="light"] .brand-light { color: #64748b; }
      html[data-theme="light"] .subtext, html[data-theme="light"] .footnote { color: #64748b; }
      html[data-theme="light"] .footnote { border-top-color: #e2e8f0; }
      html[data-theme="light"] label { color: #334155; }
      html[data-theme="light"] input { background: #fff; border-color: #cbd5e1; color: #0f172a; }
      html[data-theme="light"] input::placeholder { color: #94a3b8; }
      html[data-theme="light"] .tabs { background: #e2e8f0; }
      html[data-theme="light"] .tab { color: #475569; }
      html[data-theme="light"] .tab.active { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgba(15,23,42,.12); }
      html[data-theme="light"] .chat-header, html[data-theme="light"] .composer, html[data-theme="light"] #chat-toolbar,
      html[data-theme="light"] #search-bar, html[data-theme="light"] #reply-bar { border-color: #e2e8f0; }
      html[data-theme="light"] .room-meta, html[data-theme="light"] #room-id-label { color: #64748b; }
      html[data-theme="light"] .ghost { background: #f1f5f9; border-color: #cbd5e1; color: #334155; }
      html[data-theme="light"] .message-meta, html[data-theme="light"] .date-sep, html[data-theme="light"] #typing-indicator,
      html[data-theme="light"] .empty-state, html[data-theme="light"] #reply-bar, html[data-theme="light"] #search-count { color: #64748b; }
      html[data-theme="light"] .bubble { background: #e8edf5; border-color: #d5dde9; color: #0f172a; }
      html[data-theme="light"] .message.mine .bubble { color: #fff; }
      html[data-theme="light"] .bubble a { color: #4338ca; }
      html[data-theme="light"] .message.mine .bubble a { color: #fff; }
      html[data-theme="light"] .bubble code { background: rgba(15,23,42,.1); }
      html[data-theme="light"] .message.mine .bubble code { background: rgba(0,0,0,.25); }
      html[data-theme="light"] .reply-quote { background: rgba(15,23,42,.07); }
      html[data-theme="light"] .reply-quote strong { color: #6d28d9; }
      html[data-theme="light"] .message.mine .reply-quote { background: rgba(0,0,0,.22); }
      html[data-theme="light"] .message.mine .reply-quote strong { color: #ddd6fe; }
      html[data-theme="light"] .msg-actions button, html[data-theme="light"] .load-more { background: #fff; border-color: #cbd5e1; color: #334155; }
      html[data-theme="light"] #online-pop { background: #fff; border-color: #cbd5e1; box-shadow: 0 12px 35px rgba(15,23,42,.18); }
      html[data-theme="light"] .system-notice { background: #eef2f7; border-color: #dde4ee; color: #64748b; }
      html[data-theme="light"] .emoji-btn { background: #e2e8f0; }
      html[data-theme="light"] .emoji-tray { background: #fff; border-color: #cbd5e1; box-shadow: 0 12px 35px rgba(15,23,42,.18); }
      html[data-theme="light"] .emoji-tray button:hover { background: #e2e8f0; }
    `;
    document.head.appendChild(st);
  })();

  // ================= Toast + clipboard =================
  const toastEl = document.createElement("div");
  toastEl.id = "vc-toast";
  document.body.appendChild(toastEl);
  let toastTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }
  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); }
    catch {
      const ta = document.createElement("textarea");
      ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove();
    }
  }

  // ================= Theme (light / dark) =================
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    store.set("vc_theme", theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f1f5f9" : "#111827");
    document.querySelectorAll(".theme-btn").forEach((b) => {
      b.textContent = theme === "light" ? "🌙" : "☀️";
      b.title = theme === "light" ? "Switch to dark theme" : "Switch to light theme";
      b.setAttribute("aria-label", b.title);
    });
  }
  function makeThemeBtn() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost icon-btn theme-btn";
    b.addEventListener("click", () => {
      applyTheme(document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light");
    });
    return b;
  }

  // ================= Alerts: sound / silent / mute =================
  const MODE_INFO = {
    sound: { icon: "🔔", text: "Sound on: ping + pop-ups" },
    silent: { icon: "🔕", text: "Silent: pop-ups only, no sound" },
    mute: { icon: "🔇", text: "Muted: no sound, no pop-ups" }
  };
  const bellBtn = document.createElement("button");
  bellBtn.type = "button";
  bellBtn.id = "notify-btn";
  bellBtn.className = "ghost icon-btn";
  function updateBell() {
    bellBtn.textContent = MODE_INFO[notifyMode].icon;
    bellBtn.title = MODE_INFO[notifyMode].text + " (tap to change)";
    bellBtn.setAttribute("aria-label", bellBtn.title);
  }

  function unlockAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) audioCtx = new AC();
      }
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    } catch { /* ignore */ }
  }
  ["pointerdown", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

  function playPing() {
    if (!audioCtx) return;
    try {
      if (audioCtx.state === "suspended") audioCtx.resume();
      const t = audioCtx.currentTime, o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(740, t);
      o.frequency.setValueAtTime(988, t + 0.09);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(t); o.stop(t + 0.32);
    } catch { /* ignore */ }
  }

  bellBtn.addEventListener("click", () => {
    unlockAudio();
    const order = ["sound", "silent", "mute"];
    notifyMode = order[(order.indexOf(notifyMode) + 1) % order.length];
    store.set("vc_notify_mode", notifyMode);
    updateBell();
    toast(MODE_INFO[notifyMode].text);
    if (notifyMode === "sound") playPing();
    if (notifyMode !== "mute" && "Notification" in window && Notification.permission === "default") {
      try {
        const r = Notification.requestPermission((p) => { if (p === "denied") toast("Pop-ups are blocked in your browser settings"); });
        if (r && r.then) r.then((p) => { if (p === "denied") toast("Pop-ups are blocked in your browser settings"); }).catch(() => {});
      } catch { /* ignore */ }
    }
  });

  function updateTitle() { document.title = unread > 0 ? `(${unread}) ${baseTitle}` : baseTitle; }
  function clearUnread() { unread = 0; updateTitle(); }
  const isAway = () => document.hidden || !document.hasFocus();
  window.addEventListener("focus", clearUnread);

  function showPopup(m) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = m.username || "New message";
    const body = oneLine(parseReply(m.content).body, 120);
    const tag = "chat-" + currentRoom;
    try {
      const n = new Notification(title, { body, tag, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {
      // Android Chrome needs a service worker (sw.js) to show notifications
      if (navigator.serviceWorker) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) reg.showNotification(title, { body, tag, renotify: true, silent: notifyMode !== "sound" });
        }).catch(() => {});
      }
    }
  }

  function isOwn(m) { return m.user_id ? m.user_id === currentUserId : m.username === currentUsername; }

  function handleIncoming(m) {
    if (isOwn(m)) return;
    if (notifyMode === "sound") playPing();
    if (isAway()) {
      unread++; updateTitle();
      if (notifyMode !== "mute") showPopup(m);
    }
  }

  // ================= Chat toolbar: online / search / room ID =================
  const mkChip = (text) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ghost chip"; b.textContent = text;
    return b;
  };
  const toolbar = document.createElement("div");
  toolbar.id = "chat-toolbar";
  const onlineBtn = mkChip(""), searchBtn = mkChip("🔍 Search"), copyBtn = mkChip("📋 Room ID");
  const onlineDot = document.createElement("span"); onlineDot.className = "msg-dot on";
  const onlineLabel = document.createElement("span"); onlineLabel.textContent = "Online · 0";
  onlineBtn.append(onlineDot, onlineLabel);
  toolbar.append(onlineBtn, searchBtn, copyBtn);

  const connBar = document.createElement("div");
  connBar.id = "conn-bar"; connBar.className = "hidden";

  // search bar
  const searchBar = document.createElement("div");
  searchBar.id = "search-bar"; searchBar.className = "hidden";
  const searchInput = document.createElement("input");
  searchInput.type = "search"; searchInput.id = "chat-search-input"; searchInput.placeholder = "Search loaded messages…"; searchInput.autocomplete = "off";
  const searchCount = document.createElement("span"); searchCount.id = "search-count";
  const mkSmall = (t, title) => { const b = document.createElement("button"); b.type = "button"; b.className = "ghost chip"; b.textContent = t; b.title = title; b.setAttribute("aria-label", title); return b; };
  const searchPrev = mkSmall("▲", "Previous match"), searchNext = mkSmall("▼", "Next match"), searchClose = mkSmall("✕", "Close search");
  searchBar.append(searchInput, searchCount, searchPrev, searchNext, searchClose);

  // online pop-up
  const onlinePop = document.createElement("div");
  onlinePop.id = "online-pop"; onlinePop.className = "hidden";

  // jump to latest
  const jumpBtn = document.createElement("button");
  jumpBtn.id = "jump-btn"; jumpBtn.type = "button"; jumpBtn.className = "hidden"; jumpBtn.textContent = "↓ Latest";

  // load earlier messages
  const loadMoreEl = document.createElement("button");
  loadMoreEl.type = "button"; loadMoreEl.className = "load-more"; loadMoreEl.textContent = "↑ Load earlier messages";

  // reply bar
  const replyBar = document.createElement("div");
  replyBar.id = "reply-bar"; replyBar.className = "hidden";
  const replyText = document.createElement("span"); replyText.className = "rb-text";
  const replyCancel = document.createElement("button"); replyCancel.type = "button"; replyCancel.textContent = "✕"; replyCancel.setAttribute("aria-label", "Cancel reply");
  replyBar.append(replyText, replyCancel);

  // typing indicator element
  const typingEl = document.createElement("div");
  typingEl.id = "typing-indicator";
  typingEl.setAttribute("aria-live", "polite");

  // ================= Mount UI =================
  (function mountUI() {
    const leaveBtn = $("leave-btn");
    const actions = document.createElement("div");
    actions.className = "header-actions";
    leaveBtn.parentNode.insertBefore(actions, leaveBtn);
    actions.append(makeThemeBtn(), bellBtn, leaveBtn);

    const entryBrand = entryCard.querySelector(".brand");
    if (entryBrand) { const tb = makeThemeBtn(); tb.style.marginLeft = "auto"; entryBrand.append(tb); }

    const msgs = $("messages"), parent = msgs.parentNode;
    parent.insertBefore(toolbar, msgs);
    parent.insertBefore(connBar, msgs);
    parent.insertBefore(searchBar, msgs);
    chatCard.append(onlinePop, jumpBtn);

    const form = $("message-form");
    form.parentNode.insertBefore(typingEl, form);
    form.parentNode.insertBefore(replyBar, form);

    applyTheme(store.get("vc_theme", "dark"));
    updateBell();

    // remember me: name + last room (never the password)
    const n = store.get("vc_name", ""), r = store.get("vc_room", "");
    if (n && $("username") && !$("username").value) $("username").value = n;
    if (r && $("room-id") && !$("room-id").value) $("room-id").value = r;
  })();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ================= Scroll helpers + jump button =================
  const msgBox = $("messages");
  const isNearBottom = () => msgBox.scrollHeight - msgBox.scrollTop - msgBox.clientHeight < 140;
  function scrollBottom() { msgBox.scrollTop = msgBox.scrollHeight; pendingNew = 0; }
  function updateJump() {
    const away = currentRoom && !isNearBottom();
    if (!away) { pendingNew = 0; jumpBtn.classList.add("hidden"); return; }
    jumpBtn.textContent = pendingNew > 0 ? `↓ ${pendingNew} new message${pendingNew > 1 ? "s" : ""}` : "↓ Latest";
    const cr = chatCard.getBoundingClientRect(), mr = msgBox.getBoundingClientRect();
    jumpBtn.style.bottom = Math.max(8, cr.bottom - mr.bottom + 12) + "px";
    jumpBtn.classList.remove("hidden");
  }
  msgBox.addEventListener("scroll", updateJump, { passive: true });
  jumpBtn.addEventListener("click", () => {
    msgBox.scrollTo({ top: msgBox.scrollHeight, behavior: "smooth" });
    pendingNew = 0;
  });

  // ================= Typing indicator =================
  function renderTyping() {
    typingEl.innerHTML = "";
    const names = [...typers.values()].map((t) => t.name);
    if (!names.length) return;
    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";
    const txt = document.createElement("span");
    txt.textContent = names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : `${names.length} people are typing`;
    typingEl.append(dots, txt);
  }
  function removeTyperFor(userId, username) {
    let changed = false;
    for (const [k, t] of typers) {
      if ((userId && k === userId) || (username && t.name === username)) { clearTimeout(t.timer); typers.delete(k); changed = true; }
    }
    if (changed) renderTyping();
  }
  function clearTypers() { typers.forEach((t) => clearTimeout(t.timer)); typers.clear(); renderTyping(); }
  function handleTyping(p) {
    if (!p || (p.user_id && p.user_id === currentUserId)) return;
    const key = p.user_id || p.username;
    if (!key) return;
    const old = typers.get(key);
    if (old) clearTimeout(old.timer);
    if (p.typing === false) typers.delete(key);
    else typers.set(key, { name: p.username || "Someone", timer: setTimeout(() => { typers.delete(key); renderTyping(); }, 4000) });
    renderTyping();
  }
  function sendTyping(state) {
    if (!presenceChannel || !presenceReady) return;
    try {
      presenceChannel.send({ type: "broadcast", event: "typing", payload: { user_id: currentUserId, username: currentUsername, typing: state } });
    } catch { /* ignore */ }
  }
  function stopTyping() {
    clearTimeout(typingIdleTimer);
    if (lastTypingSent) { lastTypingSent = 0; sendTyping(false); }
  }
  $("message-input").addEventListener("input", () => {
    if (!presenceReady) return;
    if (!$("message-input").value.trim()) { stopTyping(); return; }
    const now = Date.now();
    if (now - lastTypingSent > 2000) { lastTypingSent = now; sendTyping(true); }
    clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, 3000);
  });

  // ================= Drafts (per room) =================
  const draftKey = () => "vc_draft_" + currentRoom;
  function saveDraftNow() {
    if (!currentRoom) return;
    const v = $("message-input").value;
    if (v.trim()) store.set(draftKey(), v); else store.remove(draftKey());
  }
  $("message-input").addEventListener("input", () => { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraftNow, 300); });
  window.addEventListener("pagehide", saveDraftNow);

  // ================= Auth / forms =================
  async function ensureSession() {
    const { data: { session }, error } = await client.auth.getSession();
    if (error) throw error;
    if (!session) {
      const { error: signInError } = await client.auth.signInAnonymously();
      if (signInError) throw signInError;
    }
    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError) throw userError;
    currentUserId = user.id;
  }

  $("create-tab").addEventListener("click", () => {
    $("create-tab").classList.add("active"); $("join-tab").classList.remove("active");
    createForm.classList.remove("hidden"); joinForm.classList.add("hidden"); status($("entry-status"), "");
  });
  $("join-tab").addEventListener("click", () => {
    $("join-tab").classList.add("active"); $("create-tab").classList.remove("active");
    joinForm.classList.remove("hidden"); createForm.classList.add("hidden"); status($("entry-status"), "");
  });

  createForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!client) return;
    const name = $("username").value.trim(), roomName = $("new-room").value.trim(), password = $("new-password").value;
    if (!name || !roomName || password.length < 6) return status($("entry-status"), "Enter a display name, room name and password (minimum 6 characters).");
    const btn = createForm.querySelector("button[type=submit]"); btn.disabled = true; status($("entry-status"), "Creating room…");
    try {
      await ensureSession();
      const { data, error } = await client.rpc("create_chat_room", { p_room_name: roomName, p_password: password });
      if (error) throw error;
      currentUsername = name;
      store.set("vc_name", name); store.set("vc_room", roomName);
      await enterRoom(data, roomName);
    } catch (err) { status($("entry-status"), err.message || "Could not create room."); }
    finally { btn.disabled = false; }
  });

  joinForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!client) return;
    const name = $("username").value.trim(), roomName = $("room-id").value.trim(), password = $("room-password").value;
    if (!name || !roomName || !password) return status($("entry-status"), "Enter your display name, room ID and password.");
    const btn = joinForm.querySelector("button[type=submit]"); btn.disabled = true; status($("entry-status"), "Joining room…");
    try {
      await ensureSession();
      const { data, error } = await client.rpc("join_chat_room", { p_room_name: roomName, p_password: password });
      if (error) throw error;
      currentUsername = name;
      store.set("vc_name", name); store.set("vc_room", roomName);
      await enterRoom(data, roomName);
    } catch (err) { status($("entry-status"), err.message || "Could not join room. Check the room ID and password."); }
    finally { btn.disabled = false; }
  });

  async function enterRoom(roomId, roomName) {
    currentRoom = roomId;
    currentRoomName = roomName;
    $("room-title").textContent = roomName;
    $("room-id-label").textContent = "· " + roomName;
    activeNames = new Set(); activeMembers = []; updateOnlineUI();
    joinNoticeShown = false; retryCount = 0; wasDown = false;
    clearReply(); closeSearch(); onlinePop.classList.add("hidden"); setConn("ok");
    entryCard.classList.add("hidden"); chatCard.classList.remove("hidden");
    await loadMessages();
    const draft = store.get(draftKey(), "");
    if (draft) $("message-input").value = draft;
    subscribeToMessages();
    subscribeToPresence();
    $("message-input").focus();
  }

  // ================= Messages =================
  async function loadMessages() {
    // newest 100 messages, flipped so they read oldest -> newest
    const { data, error } = await client.from("chat_messages").select(COLS)
      .eq("room_id", currentRoom).order("created_at", { ascending: false }).limit(PAGE);
    if (error) throw error;
    data.reverse();
    msgBox.innerHTML = "";
    resetLayout();
    pendingNew = 0;
    oldestCreatedAt = data.length ? data[0].created_at : null;
    newestCreatedAt = data.length ? data[data.length - 1].created_at : "1970-01-01T00:00:00+00:00";
    hasMore = data.length === PAGE;
    if (!data.length) showEmpty();
    else data.forEach((m) => appendMessage(m, msgBox, layout));
    updateLoadMore();
    scrollBottom();
    updateJump();
  }

  function updateLoadMore() {
    if (hasMore) {
      loadMoreEl.disabled = false;
      loadMoreEl.textContent = "↑ Load earlier messages";
      if (loadMoreEl.parentNode !== msgBox || msgBox.firstChild !== loadMoreEl) msgBox.prepend(loadMoreEl);
    } else if (loadMoreEl.parentNode === msgBox) {
      loadMoreEl.remove();
    }
  }

  async function loadOlder() {
    if (!currentRoom || !oldestCreatedAt || loadingOlder) return;
    loadingOlder = true;
    loadMoreEl.disabled = true; loadMoreEl.textContent = "Loading…";
    try {
      const { data, error } = await client.from("chat_messages").select(COLS)
        .eq("room_id", currentRoom).lt("created_at", oldestCreatedAt)
        .order("created_at", { ascending: false }).limit(PAGE);
      if (error) throw error;
      data.reverse();
      const fresh = data.filter((m) => !msgBox.querySelector(`[data-message-id="${m.id}"]`));
      if (fresh.length) {
        const prevH = msgBox.scrollHeight, prevTop = msgBox.scrollTop;
        const st = { dayKey: null, sender: null, time: 0, bubble: null };
        const frag = document.createDocumentFragment();
        fresh.forEach((m) => appendMessage(m, frag, st));
        // same day continues across the boundary -> drop the duplicate separator
        const firstSep = msgBox.querySelector(".date-sep");
        if (firstSep && firstSep.dataset.day === st.dayKey) firstSep.remove();
        const ref = loadMoreEl.parentNode === msgBox ? loadMoreEl.nextSibling : msgBox.firstChild;
        msgBox.insertBefore(frag, ref);
        msgBox.scrollTop = prevTop + (msgBox.scrollHeight - prevH);
      }
      if (data.length) oldestCreatedAt = data[0].created_at;
      hasMore = data.length === PAGE;
      if (!data.length) toast("No older messages");
    } catch (err) {
      toast("Could not load older messages");
    } finally {
      loadingOlder = false;
      updateLoadMore();
    }
  }
  loadMoreEl.addEventListener("click", loadOlder);

  function resetLayout() { layout.dayKey = null; layout.sender = null; layout.time = 0; layout.bubble = null; }

  function showEmpty() {
    msgBox.innerHTML = '<div class="empty-state">No messages yet. Say hello 👋</div>';
    resetLayout();
  }

  function dayLabel(d) {
    const today = new Date(), yest = new Date();
    yest.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return "Today";
    if (d.toDateString() === yest.toDateString()) return "Yesterday";
    const opts = { weekday: "short", day: "numeric", month: "short" };
    if (d.getFullYear() !== today.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString([], opts);
  }

  // Safe rich text: links, *bold*, _italic_, `code` (never uses innerHTML)
  function renderRich(container, text) {
    tokenizeRich(text).forEach((t) => {
      if (t.type === "text") { container.append(document.createTextNode(t.text)); return; }
      let el;
      if (t.type === "link") {
        el = document.createElement("a");
        el.href = t.href; el.target = "_blank"; el.rel = "noopener noreferrer nofollow";
      } else if (t.type === "code") el = document.createElement("code");
      else if (t.type === "bold") el = document.createElement("strong");
      else el = document.createElement("em");
      el.textContent = t.text;
      container.append(el);
    });
  }

  // Builds one message (plus date separator when needed) into `container`.
  function appendMessage(msg, container, st) {
    const date = new Date(msg.created_at);
    const timeText = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const parsed = parseReply(msg.content);

    const dayKey = date.toDateString();
    if (dayKey !== st.dayKey) {
      const sep = document.createElement("div");
      sep.className = "date-sep"; sep.dataset.day = dayKey;
      sep.textContent = dayLabel(date);
      container.append(sep);
      st.dayKey = dayKey; st.sender = null; st.time = 0; st.bubble = null;
    }

    const grouped = st.sender === msg.username && (date.getTime() - st.time) < GROUP_MS;

    const wrap = document.createElement("div");
    wrap.className = "message" + (msg.username === currentUsername ? " mine" : "") + (grouped ? " grouped" : "");
    wrap.dataset.messageId = msg.id;
    wrap.dataset.user = msg.username;
    wrap.dataset.body = parsed.body;

    if (!grouped) {
      const meta = document.createElement("div"); meta.className = "message-meta";
      meta.dataset.user = msg.username;
      const mdot = document.createElement("span"); mdot.className = "msg-dot";
      if (activeNames.has(msg.username)) mdot.classList.add("on");
      const mtext = document.createElement("span");
      mtext.textContent = `${msg.username} · ${timeText}`;
      meta.append(mdot, mtext);
      wrap.append(meta);
    } else if (st.bubble) {
      st.bubble.classList.add("no-tail"); // only the last bubble of a group keeps its tail
    }

    const bubble = document.createElement("div"); bubble.className = "bubble";
    if (parsed.quoteName !== undefined) {
      const q = document.createElement("div"); q.className = "reply-quote";
      const qn = document.createElement("strong"); qn.textContent = parsed.quoteName;
      const qt = document.createElement("span"); qt.textContent = parsed.quoteText;
      q.append(qn, qt);
      bubble.append(q);
    }
    renderRich(bubble, parsed.body);
    if (isBigEmoji(parsed.body)) bubble.classList.add("big-emoji");
    bubble.title = timeText;
    wrap.append(bubble);
    container.append(wrap);

    st.sender = msg.username; st.time = date.getTime(); st.bubble = bubble;
    return wrap;
  }

  // Live message arriving (or caught up after reconnect)
  function renderMessage(msg) {
    const empty = msgBox.querySelector(".empty-state"); if (empty) empty.remove();
    if (msgBox.querySelector(`[data-message-id="${msg.id}"]`)) return false;
    const near = isNearBottom();
    appendMessage(msg, msgBox, layout);
    if (msg.created_at > newestCreatedAt) newestCreatedAt = msg.created_at;
    if (near || isOwn(msg)) scrollBottom();
    else { pendingNew++; updateJump(); }
    return true;
  }

  // Messages sent while we were disconnected
  async function fetchNewer() {
    if (!currentRoom) return;
    try {
      const { data, error } = await client.from("chat_messages").select(COLS)
        .eq("room_id", currentRoom).gte("created_at", newestCreatedAt)
        .order("created_at", { ascending: true }).limit(PAGE);
      if (error) throw error;
      data.forEach((m) => renderMessage(m));
    } catch { /* ignore, will retry on next reconnect */ }
  }

  // ================= Connection handling =================
  function setConn(state) {
    if (state === "ok") { connBar.classList.add("hidden"); return; }
    wasDown = true;
    connBar.dataset.state = state;
    connBar.textContent = state === "offline" ? "You're offline. Waiting for connection…" : "Connection lost. Reconnecting…";
    connBar.classList.remove("hidden");
  }
  function onConnected() {
    clearTimeout(retryTimer); retryTimer = null; retryCount = 0;
    const was = wasDown; wasDown = false;
    setConn("ok");
    if (was) toast("Back online");
    fetchNewer();
  }
  function scheduleReconnect() {
    if (!currentRoom || retryTimer) return;
    const delay = Math.min(30000, 2000 * 2 ** retryCount);
    retryCount++;
    retryTimer = setTimeout(() => { retryTimer = null; reconnect(); }, delay);
  }
  async function reconnect() {
    if (!currentRoom || reconnecting) return;
    reconnecting = true;
    clearTimeout(retryTimer); retryTimer = null;
    try {
      if (!navigator.onLine) { setConn("offline"); return; }
      setConn("retry");
      await ensureSession();
      subscribeToMessages();
      subscribeToPresence();
    } catch { scheduleReconnect(); }
    finally { reconnecting = false; }
  }
  window.addEventListener("offline", () => { if (currentRoom) { presenceReady = false; setConn("offline"); } });
  window.addEventListener("online", () => { if (currentRoom) reconnect(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    clearUnread();
    if (!currentRoom) return;
    if (!channel || channel.state !== "joined") reconnect(); else fetchNewer();
  });

  function subscribeToMessages() {
    const old = channel; channel = null;
    if (old) client.removeChannel(old);
    const ch = client.channel("room-" + currentRoom)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${currentRoom}` },
        (payload) => {
          const m = payload.new;
          const fresh = renderMessage(m);
          removeTyperFor(m.user_id, m.username);
          if (fresh) handleIncoming(m);
        })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" }, (payload) => {
        // a message was removed (e.g. by an admin) -> drop it from the screen
        const id = payload.old && payload.old.id;
        if (id == null) return;
        const w = msgBox.querySelector(`[data-message-id="${id}"]`);
        if (w) w.remove();
      })
      .subscribe((state) => {
        if (channel !== ch) return; // stale channel
        if (state === "SUBSCRIBED") onConnected();
        else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT" || state === "CLOSED") {
          setConn(navigator.onLine ? "retry" : "offline");
          scheduleReconnect();
        }
      });
    channel = ch;
  }

  function addSystemNotice(text) {
    const empty = msgBox.querySelector(".empty-state"); if (empty) empty.remove();
    const near = isNearBottom();
    const notice = document.createElement("div");
    notice.className = "system-notice";
    notice.textContent = text;
    msgBox.append(notice);
    layout.sender = null; // a notice breaks message grouping
    if (near) scrollBottom();
  }

  // ================= Presence (green dots + online list) =================
  function refreshMessageDots() {
    document.querySelectorAll("#messages .message-meta").forEach((meta) => {
      const dot = meta.querySelector(".msg-dot");
      if (dot) dot.classList.toggle("on", activeNames.has(meta.dataset.user));
    });
  }

  function updateOnlineUI() {
    onlineLabel.textContent = `Online · ${activeMembers.length}`;
    if (!onlinePop.classList.contains("hidden")) renderOnlinePop();
  }

  function renderOnlinePop() {
    onlinePop.innerHTML = "";
    const title = document.createElement("div");
    title.className = "op-title";
    title.textContent = `ONLINE NOW · ${activeMembers.length}`;
    onlinePop.append(title);
    activeMembers.forEach((mem) => {
      const row = document.createElement("div"); row.className = "op-item";
      const dot = document.createElement("span"); dot.className = "msg-dot on";
      const name = document.createElement("span"); name.textContent = mem.name;
      row.append(dot, name);
      if (mem.id === currentUserId) {
        const you = document.createElement("span"); you.className = "op-you"; you.textContent = "(you)";
        row.append(you);
      }
      onlinePop.append(row);
    });
    if (!activeMembers.length) {
      const none = document.createElement("div"); none.textContent = "No one online"; onlinePop.append(none);
    }
  }

  function syncActiveMembers() {
    if (!presenceChannel) return;
    const byId = new Map(); // one entry per user, even with several tabs
    Object.values(presenceChannel.presenceState()).forEach((metas) => {
      (metas || []).forEach((m) => {
        const id = m.user_id || m.session_key;
        if (id && m.username && !byId.has(id)) byId.set(id, m.username);
      });
    });
    activeMembers = [...byId.entries()].map(([id, name]) => ({ id, name }))
      .sort((a, b) => (a.id === currentUserId ? -1 : b.id === currentUserId ? 1 : a.name.localeCompare(b.name)));
    activeNames = new Set(activeMembers.map((x) => x.name));
    refreshMessageDots();
    updateOnlineUI();
  }

  onlineBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!onlinePop.classList.contains("hidden")) { onlinePop.classList.add("hidden"); return; }
    renderOnlinePop();
    const cr = chatCard.getBoundingClientRect(), tr = toolbar.getBoundingClientRect();
    onlinePop.style.top = (tr.bottom - cr.top + 6) + "px";
    onlinePop.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!onlinePop.classList.contains("hidden") && !onlinePop.contains(e.target)) onlinePop.classList.add("hidden");
  });

  function subscribeToPresence() {
    const old = presenceChannel; presenceChannel = null; presenceReady = false;
    if (old) client.removeChannel(old);
    presenceKey = `${currentUserId}:${window.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()}`;
    const pch = client.channel("room-presence-" + currentRoom, {
      config: { presence: { key: presenceKey }, broadcast: { self: false } }
    });
    presenceChannel = pch;

    pch
      .on("presence", { event: "sync" }, syncActiveMembers)
      .on("broadcast", { event: "typing" }, ({ payload }) => handleTyping(payload))
      .on("presence", { event: "join" }, ({ newPresences }) => {
        (newPresences || []).forEach((person) => {
          if (person.session_key === presenceKey) return;
          addSystemNotice(`${person.username || "Someone"} joined the room`);
        });
      })
      .on("presence", { event: "leave" }, ({ leftPresences }) => {
        (leftPresences || []).forEach((person) => {
          removeTyperFor(person.user_id, person.username);
          if (person.session_key === presenceKey) return;
          addSystemNotice(`${person.username || "Someone"} left the room`);
        });
      })
      .subscribe(async (state) => {
        if (presenceChannel !== pch) return; // stale channel
        if (state === "SUBSCRIBED") {
          const { error } = await pch.track({
            user_id: currentUserId,
            username: currentUsername,
            session_key: presenceKey,
            online_at: new Date().toISOString()
          });
          if (error) status($("chat-status"), "Could not publish your online status.");
          else {
            presenceReady = true;
            status($("chat-status"), "");
            if (!joinNoticeShown) { joinNoticeShown = true; addSystemNotice("You joined the room"); }
          }
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          presenceReady = false;
          status($("chat-status"), "Live presence connection issue.");
        }
      });
  }

  // ================= Reply / copy (tap a message) =================
  function setReply(name, text) {
    replyTo = { name: String(name || "").replace(/\s*:\s*/g, " ").trim().slice(0, 40) || "Someone", text: oneLine(text, 80) };
    replyText.innerHTML = "";
    const s = document.createElement("strong"); s.textContent = `Replying to ${replyTo.name}`;
    const t = document.createElement("span"); t.textContent = replyTo.text;
    replyText.append(s, t);
    replyBar.classList.remove("hidden");
    $("message-input").focus();
  }
  function clearReply() { replyTo = null; replyBar.classList.add("hidden"); }
  replyCancel.addEventListener("click", clearReply);

  msgBox.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const act = e.target.closest(".msg-actions button");
    const wrap = e.target.closest(".message");
    if (!wrap) return;
    if (act) {
      if (act.dataset.act === "reply") setReply(wrap.dataset.user, wrap.dataset.body);
      else { copyText(wrap.dataset.body); toast("Message copied"); }
      wrap.querySelector(".msg-actions")?.remove();
      return;
    }
    if (!e.target.closest(".bubble")) return;
    if (window.getSelection && String(window.getSelection()).length) return; // user is selecting text
    const wasOpen = !!wrap.querySelector(".msg-actions");
    msgBox.querySelectorAll(".msg-actions").forEach((n) => n.remove());
    if (wasOpen) return;
    const bar = document.createElement("div"); bar.className = "msg-actions";
    [["reply", "↩ Reply"], ["copy", "⧉ Copy"]].forEach(([k, label]) => {
      const b = document.createElement("button"); b.type = "button"; b.dataset.act = k; b.textContent = label;
      bar.append(b);
    });
    wrap.append(bar);
  });

  // ================= Search in chat =================
  let hits = [], hitIdx = -1;
  function clearHits() {
    msgBox.querySelectorAll(".search-hit, .search-current").forEach((w) => w.classList.remove("search-hit", "search-current"));
    hits = []; hitIdx = -1;
  }
  function focusHit() {
    hits.forEach((w) => w.classList.remove("search-current"));
    const w = hits[hitIdx];
    if (!w) return;
    w.classList.add("search-current");
    w.scrollIntoView({ block: "center" });
    searchCount.textContent = `${hitIdx + 1}/${hits.length}`;
  }
  function runSearch() {
    clearHits();
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { searchCount.textContent = ""; return; }
    hits = [...msgBox.querySelectorAll(".message")].filter((w) => (w.dataset.body || "").toLowerCase().includes(q));
    hits.forEach((w) => w.classList.add("search-hit"));
    if (hits.length) { hitIdx = hits.length - 1; focusHit(); }
    else searchCount.textContent = "No results";
  }
  function stepHit(dir) {
    if (!hits.length) return;
    hitIdx = (hitIdx + dir + hits.length) % hits.length;
    focusHit();
  }
  function closeSearch() {
    searchBar.classList.add("hidden");
    searchInput.value = ""; searchCount.textContent = "";
    clearHits();
  }
  searchBtn.addEventListener("click", () => {
    if (searchBar.classList.contains("hidden")) { searchBar.classList.remove("hidden"); searchInput.focus(); }
    else closeSearch();
  });
  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); stepHit(e.shiftKey ? 1 : -1); } });
  searchPrev.addEventListener("click", () => stepHit(-1));
  searchNext.addEventListener("click", () => stepHit(1));
  searchClose.addEventListener("click", closeSearch);

  // copy room ID
  copyBtn.addEventListener("click", async () => {
    if (!currentRoomName) return;
    await copyText(currentRoomName);
    toast("Room ID copied");
  });

  // ================= Composer / leave =================
  $("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("message-input"), text = input.value.trim();
    if (!text || !currentRoom) return;
    const content = replyTo ? `> ${replyTo.name}: ${replyTo.text}\n${text}` : text;
    if (content.length > 2000) return status($("chat-status"), "Message too long (max 2000 characters).");
    stopTyping();
    const send = $("message-form").querySelector("button[type=submit]"); send.disabled = true;
    try {
      const { error } = await client.from("chat_messages").insert({ room_id: currentRoom, username: currentUsername, content });
      if (error) throw error;
      input.value = ""; status($("chat-status"), "");
      store.remove(draftKey());
      clearReply();
    } catch (err) { status($("chat-status"), err.message || "Message could not be sent."); }
    finally { send.disabled = false; input.focus(); }
  });

  $("emoji-btn").addEventListener("click", () => $("emoji-tray").classList.toggle("hidden"));
  $("emoji-tray").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    const input = $("message-input"), start = input.selectionStart, end = input.selectionEnd;
    input.value = input.value.slice(0, start) + e.target.textContent + input.value.slice(end);
    input.focus(); input.selectionStart = input.selectionEnd = start + e.target.textContent.length;
    input.dispatchEvent(new Event("input"));
    $("emoji-tray").classList.add("hidden");
  });

  $("leave-btn").addEventListener("click", async () => {
    saveDraftNow();
    stopTyping();
    const c = channel, p = presenceChannel;
    channel = null; presenceChannel = null; presenceReady = false; currentRoom = null;
    clearTimeout(retryTimer); retryTimer = null;
    if (p) await client.removeChannel(p);
    if (c) await client.removeChannel(c);
    currentUserId = null; presenceKey = null;
    activeNames = new Set(); activeMembers = []; updateOnlineUI();
    clearTypers(); clearUnread(); clearReply(); closeSearch(); setConn("ok");
    onlinePop.classList.add("hidden"); jumpBtn.classList.add("hidden");
    hasMore = false; oldestCreatedAt = null;
    chatCard.classList.add("hidden"); entryCard.classList.remove("hidden");
    showEmpty();
    $("message-input").value = ""; status($("chat-status"), "");
  });
})();
