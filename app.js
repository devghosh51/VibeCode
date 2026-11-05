(() => {
  const $ = (id) => document.getElementById(id);
  const status = (el, msg) => { el.textContent = msg || ""; };
  const validConfig = () =>
    window.SUPABASE_URL && !window.SUPABASE_URL.includes("YOUR-PROJECT") &&
    window.SUPABASE_ANON_KEY && !window.SUPABASE_ANON_KEY.includes("YOUR_");

  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
  };

  let client, currentRoom = null, currentUsername = "", channel = null, presenceChannel = null,
      currentUserId = null, presenceKey = null, activeNames = new Set(), presenceReady = false;

  // message layout tracking (date separators + grouping)
  const GROUP_MS = 5 * 60 * 1000;
  let lastDayKey = null, lastSender = null, lastTime = 0, lastBubble = null;

  // reply tracking
  let replyingTo = null;

  // typing indicator state
  const typers = new Map();
  let lastTypingSent = 0, typingIdleTimer = null;

  // alerts (sound / unread count / pop-ups)
  const baseTitle = document.title;
  let unread = 0, audioCtx = null;
  let notifyMode = store.get("vc_notify_mode", "sound");
  if (!["sound", "silent", "mute"].includes(notifyMode)) notifyMode = "sound";

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
      .msg-dot { display: none; width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 0 2px rgba(34,197,94,.25); margin-right: 6px; vertical-align: middle; }
      .msg-dot.on { display: inline-block; }

      .header-actions { display: flex; gap: 6px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
      .icon-btn { padding: 9px 11px; line-height: 1; font-size: 14px; cursor: pointer; }

      .date-sep { align-self: center; width: 100%; display: flex; align-items: center; gap: 10px; color: #94a3b8; font-size: 11px; font-weight: 600; margin: 4px 0; }
      .date-sep::before, .date-sep::after { content: ""; flex: 1; height: 1px; background: rgba(148,163,184,.25); }

      .message { position: relative; }
      .message.grouped { margin-top: -9px; }
      .message .bubble.no-tail { border-radius: 15px !important; }
      .bubble { cursor: pointer; user-select: text; word-break: break-word; }

      /* Reply preview bar */
      #reply-bar { display: none; background: rgba(148,163,184,0.12); border-left: 3px solid #3b82f6; padding: 6px 12px; margin: 0 20px 6px; border-radius: 4px; font-size: 12px; align-items: center; justify-content: space-between; }
      #reply-bar.active { display: flex; }
      #reply-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80%; }
      #reply-close { cursor: pointer; border: none; background: transparent; font-size: 14px; color: #94a3b8; }

      /* Quotes & Embeds */
      .bubble-quote { background: rgba(0,0,0,0.15); border-left: 2px solid currentColor; padding: 4px 8px; border-radius: 4px; margin-bottom: 6px; font-size: 12px; opacity: 0.85; }
      .bubble-img { max-width: 100%; max-height: 250px; border-radius: 8px; margin-top: 6px; display: block; }
      .bubble a { color: inherit; text-decoration: underline; word-break: break-all; }

      /* Reactions */
      .reaction-bar { position: absolute; right: 8px; top: -14px; background: #1e293b; border: 1px solid rgba(255,255,255,0.1); border-radius: 999px; padding: 2px 6px; display: none; gap: 4px; z-index: 10; box-shadow: 0 4px 12px rgba(0,0,0,0.3); }
      .message:hover .reaction-bar { display: flex; }
      .reaction-bar button { background: none; border: none; font-size: 14px; cursor: pointer; padding: 2px; transition: transform 0.1s; }
      .reaction-bar button:hover { transform: scale(1.3); }
      .reaction-pills { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
      .reaction-pill { background: rgba(255,255,255,0.1); font-size: 11px; padding: 1px 6px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.12); }

      /* Scroll To Bottom Button */
      #scroll-btn { position: absolute; right: 24px; bottom: 80px; background: #1f2937; color: #fff; border: 1px solid rgba(255,255,255,0.2); border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer; display: none; align-items: center; gap: 6px; z-index: 20; box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
      #scroll-btn.show { display: flex; }

      /* Typing indicator */
      #typing-indicator { flex: none; min-height: 22px; padding: 2px 22px 6px; font-size: 11px; color: #94a3b8; display: flex; align-items: center; gap: 7px; }
      .typing-dots { display: inline-flex; gap: 3px; align-items: center; }
      .typing-dots i { width: 5px; height: 5px; border-radius: 50%; background: #38bdf8; opacity: .35; animation: vcBlink 1.2s infinite ease-in-out; }
      .typing-dots i:nth-child(2) { animation-delay: .2s; }
      .typing-dots i:nth-child(3) { animation-delay: .4s; }
      @keyframes vcBlink { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }

      #vc-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); background: #111827; color: #fff; padding: 10px 16px; border-radius: 999px; font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 9999; max-width: 90vw; text-align: center; border: 1px solid rgba(255,255,255,.18); }
      #vc-toast.show { opacity: 1; }

      /* Light theme */
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
      html[data-theme="light"] .chat-header, html[data-theme="light"] .composer { border-color: #e2e8f0; }
      html[data-theme="light"] .room-meta, html[data-theme="light"] #room-id-label { color: #64748b; }
      html[data-theme="light"] .ghost { background: #f1f5f9; border-color: #cbd5e1; color: #334155; }
      html[data-theme="light"] .message-meta, html[data-theme="light"] .date-sep, html[data-theme="light"] #typing-indicator, html[data-theme="light"] .empty-state { color: #64748b; }
      html[data-theme="light"] .bubble { background: #e8edf5; border-color: #d5dde9; color: #0f172a; }
      html[data-theme="light"] .message.mine .bubble { color: #fff; }
      html[data-theme="light"] .system-notice { background: #eef2f7; border-color: #dde4ee; color: #64748b; }
      html[data-theme="light"] .emoji-btn { background: #e2e8f0; }
      html[data-theme="light"] .emoji-tray { background: #fff; border-color: #cbd5e1; box-shadow: 0 12px 35px rgba(15,23,42,.18); }
      html[data-theme="light"] .emoji-tray button:hover { background: #e2e8f0; }
      html[data-theme="light"] .reaction-bar { background: #ffffff; border-color: #e2e8f0; }
      html[data-theme="light"] #scroll-btn { background: #ffffff; color: #0f172a; border-color: #cbd5e1; }
    `;
    document.head.appendChild(st);
  })();

  // ================= Toast =================
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden) clearUnread(); });
  window.addEventListener("focus", clearUnread);
  const isAway = () => document.hidden || !document.hasFocus();

  function showPopup(m) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const title = m.username || "New message";
    const body = (m.content || "").slice(0, 120);
    const tag = "chat-" + currentRoom;
    try {
      const n = new Notification(title, { body, tag, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {
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

  // ================= Share / Invite Button =================
  function makeShareBtn() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ghost icon-btn";
    b.textContent = "🔗";
    b.title = "Copy Room Invite Link";
    b.addEventListener("click", () => {
      const room = $("room-title").textContent;
      const url = new URL(window.location.href);
      url.searchParams.set("room", room);
      navigator.clipboard.writeText(url.toString()).then(() => {
        toast("Invite link copied to clipboard!");
      }).catch(() => toast("Failed to copy link"));
    });
    return b;
  }

  // ================= Scroll To Bottom Button =================
  const scrollBtn = document.createElement("button");
  scrollBtn.id = "scroll-btn";
  scrollBtn.innerHTML = `<span>↓ New messages</span>`;
  chatCard.appendChild(scrollBtn);
  scrollBtn.addEventListener("click", () => {
    scrollBottom(true);
    scrollBtn.classList.remove("show");
  });

  const msgContainer = $("messages");
  msgContainer.addEventListener("scroll", () => {
    const dist = msgContainer.scrollHeight - msgContainer.scrollTop - msgContainer.clientHeight;
    if (dist < 100) scrollBtn.classList.remove("show");
  });

  // ================= Reply UI =================
  const replyBar = document.createElement("div");
  replyBar.id = "reply-bar";
  replyBar.innerHTML = `<span id="reply-text"></span><button type="button" id="reply-close">✕</button>`;
  $("message-form").parentNode.insertBefore(replyBar, $("message-form"));
  replyBar.querySelector("#reply-close").addEventListener("click", cancelReply);

  function setReply(sender, snippet) {
    replyingTo = { sender, snippet };
    replyBar.querySelector("#reply-text").textContent = `Replying to ${sender}: "${snippet.slice(0, 30)}..."`;
    replyBar.classList.add("active");
    $("message-input").focus();
  }
  function cancelReply() {
    replyingTo = null;
    replyBar.classList.remove("active");
  }

  // ================= Header / entry-card buttons =================
  (function mountButtons() {
    const leaveBtn = $("leave-btn");
    const actions = document.createElement("div");
    actions.className = "header-actions";
    leaveBtn.parentNode.insertBefore(actions, leaveBtn);
    actions.append(makeShareBtn(), makeThemeBtn(), bellBtn, leaveBtn);

    const entryBrand = entryCard.querySelector(".brand");
    if (entryBrand) { const tb = makeThemeBtn(); tb.style.marginLeft = "auto"; entryBrand.append(tb); }

    applyTheme(store.get("vc_theme", "dark"));
    updateBell();

    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get("room");
    if (roomParam) {
      $("join-tab").click();
      $("room-id").value = roomParam;
    }
  })();

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  // ================= Typing Indicator Implementation =================
  const typingEl = document.createElement("div");
  typingEl.id = "typing-indicator";
  typingEl.setAttribute("aria-live", "polite");
  $("message-form").parentNode.insertBefore(typingEl, $("message-form"));

  function renderTyping() {
    typingEl.innerHTML = "";
    const names = [...typers.values()].map((t) => t.name);
    if (!names.length) return;

    const dots = document.createElement("span");
    dots.className = "typing-dots";
    dots.innerHTML = "<i></i><i></i><i></i>";

    const txt = document.createElement("span");
    txt.textContent = names.length === 1 ? `${names[0]} is typing...`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing...`
      : `${names.length} people are typing...`;

    typingEl.append(dots, txt);
  }

  function removeTyperFor(userId, username) {
    let changed = false;
    for (const [k, t] of typers) {
      if ((userId && k === userId) || (username && t.name === username)) {
        clearTimeout(t.timer);
        typers.delete(k);
        changed = true;
      }
    }
    if (changed) renderTyping();
  }

  function clearTypers() {
    typers.forEach((t) => clearTimeout(t.timer));
    typers.clear();
    renderTyping();
  }

  function handleTyping(p) {
    if (!p || (p.user_id && p.user_id === currentUserId) || p.username === currentUsername) return;
    const key = p.user_id || p.username;
    if (!key) return;

    const old = typers.get(key);
    if (old) clearTimeout(old.timer);

    if (p.typing === false) {
      typers.delete(key);
    } else {
      typers.set(key, {
        name: p.username || "Someone",
        timer: setTimeout(() => {
          typers.delete(key);
          renderTyping();
        }, 3500)
      });
    }
    renderTyping();
  }

  function sendTyping(state) {
    if (!presenceChannel || !presenceReady) return;
    try {
      presenceChannel.send({
        type: "broadcast",
        event: "typing",
        payload: { user_id: currentUserId, username: currentUsername, typing: state }
      });
    } catch { /* ignore */ }
  }

  function stopTyping() {
    clearTimeout(typingIdleTimer);
    if (lastTypingSent) {
      lastTypingSent = 0;
      sendTyping(false);
    }
  }

  // Input listener tracking typing state
  $("message-input").addEventListener("input", () => {
    if (!presenceReady) return;
    const val = $("message-input").value.trim();
    if (!val) {
      stopTyping();
      return;
    }
    const now = Date.now();
    if (now - lastTypingSent > 2000) {
      lastTypingSent = now;
      sendTyping(true);
    }
    clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(stopTyping, 3000);
  });

  $("message-input").addEventListener("blur", stopTyping);

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
      await enterRoom(data, roomName);
    } catch (err) { status($("entry-status"), err.message || "Could not join room. Check the room ID and password."); }
    finally { btn.disabled = false; }
  });

  async function enterRoom(roomId, roomName) {
    currentRoom = roomId;
    $("room-title").textContent = roomName;
    $("room-id-label").textContent = "· " + roomName;
    activeNames = new Set();
    entryCard.classList.add("hidden"); chatCard.classList.remove("hidden");
    await loadMessages();
    subscribeToMessages();
    subscribeToPresence();
    $("message-input").focus();
  }

  // ================= Messages & Rich Rendering =================
  async function loadMessages() {
    const { data, error } = await client.from("chat_messages").select("id, room_id, username, content, created_at")
      .eq("room_id", currentRoom).order("created_at", { ascending: false }).limit(100);
    if (error) throw error;
    data.reverse();
    $("messages").innerHTML = "";
    resetLayout();
    if (!data.length) showEmpty();
    else data.forEach(renderMessage);
    scrollBottom();
  }

  function resetLayout() { lastDayKey = null; lastSender = null; lastTime = 0; lastBubble = null; }

  function showEmpty() {
    $("messages").innerHTML = '<div class="empty-state">No messages yet. Say hello 👋</div>';
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

  function buildRichContent(rawText) {
    const fragment = document.createDocumentFragment();
    let text = rawText;

    if (text.startsWith("> @")) {
      const parts = text.split("

");
      const quote = parts[0].replace("> ", "");
      text = parts.slice(1).join("

");
      const qEl = document.createElement("div");
      qEl.className = "bubble-quote";
      qEl.textContent = quote;
      fragment.appendChild(qEl);
    }

    const contentDiv = document.createElement("div");
    const words = text.split(/(\s+)/);

    words.forEach(word => {
      if (/^https?:\/\/[^\s]+$/.test(word)) {
        if (/\.(jpeg|jpg|gif|png|webp)($|\?)/i.test(word)) {
          const img = document.createElement("img");
          img.src = word;
          img.className = "bubble-img";
          img.loading = "lazy";
          contentDiv.appendChild(img);
        } else {
          const a = document.createElement("a");
          a.href = word;
          a.target = "_blank";
          a.rel = "noopener noreferrer";
          a.textContent = word;
          contentDiv.appendChild(a);
        }
      } else {
        contentDiv.appendChild(document.createTextNode(word));
      }
    });

    fragment.appendChild(contentDiv);
    return fragment;
  }

  function renderMessage(msg) {
    const box = $("messages");
    const empty = box.querySelector(".empty-state"); if (empty) empty.remove();
    if (box.querySelector(`[data-message-id="${msg.id}"]`)) return false;

    const date = new Date(msg.created_at);
    const timeText = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

    const dayKey = date.toDateString();
    if (dayKey !== lastDayKey) {
      const sep = document.createElement("div");
      sep.className = "date-sep";
      sep.textContent = dayLabel(date);
      box.append(sep);
      lastDayKey = dayKey; lastSender = null; lastTime = 0; lastBubble = null;
    }

    const grouped = lastSender === msg.username && (date.getTime() - lastTime) < GROUP_MS;

    const wrap = document.createElement("div");
    wrap.className = "message" + (msg.username === currentUsername ? " mine" : "") + (grouped ? " grouped" : "");
    wrap.dataset.messageId = msg.id;

    if (!grouped) {
      const meta = document.createElement("div"); meta.className = "message-meta";
      meta.dataset.user = msg.username;
      const mdot = document.createElement("span"); mdot.className = "msg-dot";
      if (activeNames.has(msg.username)) mdot.classList.add("on");
      const mtext = document.createElement("span");
      mtext.textContent = `${msg.username} · ${timeText}`;
      meta.append(mdot, mtext);
      wrap.append(meta);
    } else if (lastBubble) {
      lastBubble.classList.add("no-tail");
    }

    const reactBar = document.createElement("div");
    reactBar.className = "reaction-bar";
    ["❤️", "😂", "👍", "🔥", "😮"].forEach(emoji => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = emoji;
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        sendReaction(msg.id, emoji);
      });
      reactBar.appendChild(btn);
    });
    wrap.append(reactBar);

    const bubble = document.createElement("div"); 
    bubble.className = "bubble";
    bubble.title = `${timeText} - Double-click to quote reply`;
    bubble.appendChild(buildRichContent(msg.content));
    
    bubble.addEventListener("dblclick", () => {
      setReply(msg.username, msg.content);
    });

    const pills = document.createElement("div");
    pills.className = "reaction-pills";
    bubble.append(pills);

    wrap.append(bubble); 
    box.append(wrap);

    lastSender = msg.username; lastTime = date.getTime(); lastBubble = bubble;
    
    const dist = box.scrollHeight - box.scrollTop - box.clientHeight;
    if (dist > 150) {
      scrollBtn.classList.add("show");
    } else {
      scrollBottom();
    }
    return true;
  }

  // ================= Realtime Reactions =================
  function sendReaction(messageId, emoji) {
    if (!presenceChannel || !presenceReady) return;
    addReactionToDOM(messageId, emoji, currentUsername);
    try {
      presenceChannel.send({
        type: "broadcast",
        event: "reaction",
        payload: { messageId, emoji, user: currentUsername }
      });
    } catch { /* ignore */ }
  }

  function addReactionToDOM(messageId, emoji, user) {
    const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
    if (!msgEl) return;
    const container = msgEl.querySelector(".reaction-pills");
    let pill = container.querySelector(`[data-emoji="${emoji}"]`);
    if (!pill) {
      pill = document.createElement("span");
      pill.className = "reaction-pill";
      pill.dataset.emoji = emoji;
      pill.dataset.count = "1";
      pill.textContent = `${emoji} 1`;
      container.appendChild(pill);
    } else {
      const count = parseInt(pill.dataset.count, 10) + 1;
      pill.dataset.count = count;
      pill.textContent = `${emoji} ${count}`;
    }
  }

  function subscribeToMessages() {
    if (channel) client.removeChannel(channel);
    channel = client.channel("room-" + currentRoom)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${currentRoom}` },
        (payload) => {
          const m = payload.new;
          const fresh = renderMessage(m);
          removeTyperFor(m.user_id, m.username);
          if (fresh) handleIncoming(m);
        })
      .subscribe((state) => { if (state === "CHANNEL_ERROR") status($("chat-status"), "Live connection issue. Refresh the page to reconnect."); });
  }

  function addSystemNotice(text) {
    const box = $("messages");
    const empty = box.querySelector(".empty-state"); if (empty) empty.remove();
    const notice = document.createElement("div");
    notice.className = "system-notice";
    notice.textContent = text;
    box.append(notice);
    lastSender = null;
    scrollBottom();
  }

  // ================= Presence =================
  function refreshMessageDots() {
    document.querySelectorAll("#messages .message-meta").forEach((meta) => {
      const dot = meta.querySelector(".msg-dot");
      if (dot) dot.classList.toggle("on", activeNames.has(meta.dataset.user));
    });
  }

  function syncActiveMembers() {
    if (!presenceChannel) return;
    const names = new Set();
    Object.values(presenceChannel.presenceState()).forEach((metas) => {
      (metas || []).forEach((m) => { if (m.username) names.add(m.username); });
    });
    activeNames = names;
    refreshMessageDots();
  }

  function subscribeToPresence() {
    if (presenceChannel) client.removeChannel(presenceChannel);
    presenceReady = false;
    presenceKey = `${currentUserId}:${window.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()}`;
    presenceChannel = client.channel("room-presence-" + currentRoom, {
      config: { presence: { key: presenceKey }, broadcast: { self: false } }
    });

    presenceChannel
      .on("presence", { event: "sync" }, syncActiveMembers)
      .on("broadcast", { event: "typing" }, ({ payload }) => handleTyping(payload))
      .on("broadcast", { event: "reaction" }, ({ payload }) => {
        if (payload && payload.messageId) {
          addReactionToDOM(payload.messageId, payload.emoji, payload.user);
        }
      })
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
        if (state === "SUBSCRIBED") {
          const { error } = await presenceChannel.track({
            user_id: currentUserId,
            username: currentUsername,
            session_key: presenceKey,
            online_at: new Date().toISOString()
          });
          if (error) status($("chat-status"), "Could not publish your online status.");
          else { presenceReady = true; addSystemNotice("You joined the room"); }
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          presenceReady = false;
          status($("chat-status"), "Live presence connection issue. Refresh the page to reconnect.");
        }
      });
  }

  // ================= Composer / Leave / Slash Commands =================
  $("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("message-input");
    let content = input.value.trim();
    if (!content || !currentRoom) return;

    if (content === "/clear") {
      $("messages").innerHTML = "";
      showEmpty();
      input.value = "";
      return;
    }
    if (content === "/shrug") content = "¯\\_(ツ)_/¯";
    if (content === "/tableflip") content = "(╯°□°)╯︵ ┻━┻";
    if (content === "/lenny") content = "( ͡° ͜ʖ ͡°)";

    if (replyingTo) {
      content = `> @${replyingTo.sender}: ${replyingTo.snippet}\n\n${content}`;
      cancelReply();
    }

    stopTyping();
    const send = $("message-form").querySelector("button[type=submit]"); 
    send.disabled = true;

    try {
      const { error } = await client.from("chat_messages").insert({ room_id: currentRoom, username: currentUsername, content });
      if (error) throw error;
      input.value = ""; status($("chat-status"), "");
    } catch (err) { 
      status($("chat-status"), err.message || "Message could not be sent."); 
    } finally { 
      send.disabled = false; 
      input.focus(); 
    }
  });

  $("emoji-btn").addEventListener("click", () => $("emoji-tray").classList.toggle("hidden"));
  $("emoji-tray").addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    const input = $("message-input"), start = input.selectionStart, end = input.selectionEnd;
    input.value = input.value.slice(0, start) + e.target.textContent + input.value.slice(end);
    input.focus(); input.selectionStart = input.selectionEnd = start + e.target.textContent.length;
    $("emoji-tray").classList.add("hidden");
  });

  $("leave-btn").addEventListener("click", async () => {
    stopTyping();
    cancelReply();
    presenceReady = false;
    if (presenceChannel) await client.removeChannel(presenceChannel);
    if (channel) await client.removeChannel(channel);
    presenceChannel = null; channel = null; currentRoom = null; currentUserId = null; presenceKey = null;
    activeNames = new Set(); clearTypers(); clearUnread();
    chatCard.classList.add("hidden"); entryCard.classList.remove("hidden");
    showEmpty();
    $("message-input").value = ""; status($("chat-status"), "");
  });

  function scrollBottom(smooth = false) { 
    const box = $("messages"); 
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? "smooth" : "auto" }); 
  }
})();