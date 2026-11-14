(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  // Tiny DOM helper. Text is always inserted as text (never as HTML), so chat content cannot inject code.
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
        else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
      }
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  // <pure>
  const fmtDate = (iso) => new Date(iso).toLocaleString([], { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  function ago(iso) {
    if (!iso) return "never";
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    const m = s / 60; if (m < 60) return Math.floor(m) + "m ago";
    const hr = m / 60; if (hr < 24) return Math.floor(hr) + "h ago";
    const d = hr / 24; if (d < 30) return Math.floor(d) + "d ago";
    return new Date(iso).toLocaleDateString();
  }
  const shortId = (id) => String(id || "").slice(0, 8);
  // CSV cell; also neutralises spreadsheet formulas (=, +, -, @)
  function csvCell(v) {
    let s = String(v == null ? "" : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }
  const safeName = (s) => String(s || "room").replace(/[^\w\-]+/g, "_").slice(0, 40);
  // </pure>

  let toastTimer = null;
  function toast(text) {
    const t = $("toast");
    t.textContent = text; t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const a = h("a", { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function friendly(err) {
    const msg = (err && err.message) || String(err);
    if (/Could not find the function|schema cache/i.test(msg)) return "Admin functions not found. Run admin-setup.sql in the Supabase SQL Editor first.";
    return msg;
  }

  const loginCard = $("login-card"), appEl = $("app"), loginStatus = $("login-status"), view = $("view");
  function showLogin(msg) { appEl.classList.add("hidden"); loginCard.classList.remove("hidden"); loginStatus.textContent = msg || ""; }
  function showApp() { loginCard.classList.add("hidden"); appEl.classList.remove("hidden"); }

  $("login-form").addEventListener("submit", (e) => e.preventDefault());

  const cfgOK = window.SUPABASE_URL && !String(window.SUPABASE_URL).includes("YOUR-PROJECT") &&
    window.SUPABASE_ANON_KEY && !String(window.SUPABASE_ANON_KEY).includes("YOUR_");
  if (!cfgOK || !window.supabase) { showLogin("Setup required: add your Supabase URL and anon key in config.js."); return; }

  // Separate storage key so the admin login never replaces the chat's anonymous session.
  const client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
    auth: { storageKey: "vibechat-admin-auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: false }
  });

  async function rpc(name, args) {
    const { data, error } = await client.rpc(name, args || {});
    if (error) throw error;
    return data;
  }

  let rooms = [];

  // ---------------- Navigation ----------------
  function setNav(v) { document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === v)); }
  async function go(v, arg) {
    setNav(v === "room" ? "rooms" : v);
    view.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
    window.scrollTo(0, 0);
    try {
      if (v === "dashboard") await viewDashboard();
      else if (v === "rooms") await viewRooms();
      else if (v === "search") viewSearch();
      else if (v === "room") await viewRoom(arg);
    } catch (e) { view.replaceChildren(h("p", { class: "error", text: friendly(e) })); }
  }
  document.querySelectorAll("#nav button").forEach((b) => b.addEventListener("click", () => go(b.dataset.view)));

  function roomRow(r) {
    return h("button", { class: "row", type: "button", onclick: () => go("room", r) },
      h("div", { class: "name", text: r.room_name }),
      h("div", { class: "meta", text: `${r.member_count} members · ${r.message_count} messages · active ${ago(r.last_message_at)}` }));
  }

  // ---------------- Dashboard ----------------
  async function viewDashboard() {
    const [s, rs] = await Promise.all([rpc("admin_stats"), rpc("admin_list_rooms")]);
    rooms = rs;
    const stat = (label, val) => h("div", { class: "stat" }, h("div", { class: "stat-n", text: Number(val).toLocaleString() }), h("div", { class: "stat-l", text: label }));
    const daily = s.daily || [];
    const max = Math.max(1, ...daily.map((d) => d.count));
    const chart = h("div", { class: "bars" }, daily.map((d) => {
      const dt = new Date(d.day + "T00:00:00");
      return h("div", { class: "bar-col" },
        h("div", { class: "bar-n", text: d.count }),
        h("div", { class: "bar", style: `height:${Math.max(4, Math.round((d.count / max) * 100))}px` }),
        h("div", { class: "bar-l", text: dt.toLocaleDateString([], { weekday: "short" }) }));
    }));
    const top = [...rooms].sort((a, b) => b.message_count - a.message_count).slice(0, 5);
    view.replaceChildren(
      h("h2", { text: "Overview" }),
      h("div", { class: "stats" },
        stat("Rooms", s.rooms), stat("Users", s.users), stat("Messages", s.messages),
        stat("Last 24 hours", s.messages_24h), stat("Active rooms (7d)", s.active_rooms_7d), stat("Room joins", s.members)),
      h("h3", { text: "Messages per day" }), h("div", { class: "card" }, chart),
      h("h3", { text: "Top rooms" }),
      h("div", { class: "list" }, top.length ? top.map(roomRow) : [h("p", { class: "muted", text: "No rooms yet." })])
    );
  }

  // ---------------- Rooms ----------------
  async function viewRooms() {
    rooms = await rpc("admin_list_rooms");
    const q = h("input", { type: "search", placeholder: "Search rooms…", oninput: draw });
    const sort = h("select", { onchange: draw },
      [["activity", "Recent activity"], ["new", "Newest"], ["msgs", "Most messages"], ["members", "Most members"]].map(([v, l]) => h("option", { value: v, text: l })));
    const list = h("div", { class: "list" });
    const when = (r) => new Date(r.last_message_at || r.created_at).getTime();
    const by = {
      activity: (a, b) => when(b) - when(a),
      new: (a, b) => new Date(b.created_at) - new Date(a.created_at),
      msgs: (a, b) => b.message_count - a.message_count,
      members: (a, b) => b.member_count - a.member_count
    };
    function draw() {
      const term = q.value.trim().toLowerCase();
      const rs = rooms.filter((r) => !term || r.room_name.toLowerCase().includes(term)).sort(by[sort.value]);
      list.replaceChildren(...(rs.length ? rs.map(roomRow) : [h("p", { class: "muted", text: "No rooms found." })]));
    }
    view.replaceChildren(h("h2", { text: `Rooms (${rooms.length})` }), h("div", { class: "toolbar" }, q, sort), list);
    draw();
  }

  // ---------------- Room detail ----------------
  async function viewRoom(room) {
    let tab = "messages";
    const tabs = h("div", { class: "tabs" });
    const body = h("div");
    function drawTabs() {
      tabs.replaceChildren(...["messages", "members", "settings"].map((t) =>
        h("button", { class: "tab" + (tab === t ? " active" : ""), type: "button", onclick: () => { tab = t; drawTabs(); drawBody(); } }, t[0].toUpperCase() + t.slice(1))));
    }
    async function drawBody() {
      body.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
      try {
        if (tab === "messages") await tabMessages(room, body);
        else if (tab === "members") await tabMembers(room, body);
        else tabSettings(room, body);
      } catch (e) { body.replaceChildren(h("p", { class: "error", text: friendly(e) })); }
    }
    view.replaceChildren(
      h("button", { class: "btn", type: "button", onclick: () => go("rooms") }, "← Rooms"),
      h("h2", { text: room.room_name }),
      h("p", { class: "muted", text: `Created ${fmtDate(room.created_at)} · ${room.member_count} members · ${room.message_count} messages` }),
      tabs, body);
    drawTabs();
    await drawBody();
  }

  async function tabMessages(room, body) {
    let msgs = [], done = false;
    const list = h("div", { class: "list" });
    const more = h("button", { class: "btn", type: "button", onclick: loadMore }, "Load older messages");
    const filter = h("input", { type: "search", placeholder: "Filter loaded messages…", oninput: renderList });
    const fetchPage = (before, limit) => rpc("admin_list_messages", { p_room: room.id, p_before: before, p_limit: limit });

    function msgRow(m) {
      return h("div", { class: "msg" },
        h("div", { class: "msg-top" },
          h("strong", { text: m.username }),
          h("span", { class: "muted", text: ` · ${fmtDate(m.created_at)} · ${shortId(m.user_id)}` }),
          h("button", { class: "btn danger sm", type: "button", onclick: () => delMsg(m) }, "Delete")),
        h("div", { class: "msg-body", text: m.content }));
    }
    function renderList() {
      const q = filter.value.trim().toLowerCase();
      const shown = msgs.filter((m) => !q || m.content.toLowerCase().includes(q) || m.username.toLowerCase().includes(q));
      list.replaceChildren(...(shown.length ? shown.map(msgRow) : [h("p", { class: "muted", text: "No messages." })]));
      more.classList.toggle("hidden", done);
    }
    async function delMsg(m) {
      if (!confirm("Delete this message permanently?")) return;
      try {
        await rpc("admin_delete_message", { p_id: m.id });
        msgs = msgs.filter((x) => x.id !== m.id);
        room.message_count = Math.max(0, room.message_count - 1);
        renderList(); toast("Message deleted");
      } catch (e) { toast(friendly(e)); }
    }
    async function loadMore() {
      more.disabled = true;
      try {
        const page = await fetchPage(msgs[msgs.length - 1].created_at, 100);
        const have = new Set(msgs.map((x) => x.id));
        msgs.push(...page.filter((x) => !have.has(x.id)));
        done = page.length < 100;
        renderList();
      } catch (e) { toast(friendly(e)); }
      more.disabled = false;
    }
    async function exportAll(format) {
      toast("Preparing export…");
      try {
        let all = [], before = null;
        for (let i = 0; i < 50; i++) {
          const page = await fetchPage(before, 1000);
          all = all.concat(page);
          if (page.length < 1000) break;
          before = page[page.length - 1].created_at;
        }
        all.reverse(); // oldest first
        if (format === "json") {
          download(`${safeName(room.room_name)}-chat.json`, JSON.stringify(all.map(({ id, user_id, username, content, created_at }) => ({ id, user_id, username, content, created_at })), null, 2), "application/json");
        } else {
          const lines = ["id,created_at,user_id,username,content"].concat(all.map((m) => [m.id, m.created_at, m.user_id, m.username, m.content].map(csvCell).join(",")));
          download(`${safeName(room.room_name)}-chat.csv`, lines.join("\n"), "text/csv");
        }
        toast(`Exported ${all.length} messages`);
      } catch (e) { toast(friendly(e)); }
    }

    const first = await fetchPage(null, 100);
    msgs = first; done = first.length < 100;
    body.replaceChildren(
      h("div", { class: "toolbar" }, filter,
        h("button", { class: "btn", type: "button", onclick: () => exportAll("json") }, "Export JSON"),
        h("button", { class: "btn", type: "button", onclick: () => exportAll("csv") }, "Export CSV")),
      list, h("div", { style: "margin-top:10px" }, more));
    renderList();
  }

  async function tabMembers(room, body) {
    const members = await rpc("admin_list_members", { p_room: room.id });
    const row = (m) => h("div", { class: "msg" },
      h("div", { class: "msg-top" },
        h("strong", { text: m.last_username || "(no messages yet)" }),
        h("span", { class: "muted", text: ` · ${shortId(m.user_id)}` }),
        h("button", { class: "btn danger sm", type: "button", onclick: async () => {
          if (!confirm(`Remove this member from "${room.room_name}"? They can rejoin with the room password unless you change it.`)) return;
          try { await rpc("admin_remove_member", { p_room: room.id, p_user: m.user_id }); room.member_count = Math.max(0, room.member_count - 1); toast("Member removed"); await tabMembers(room, body); }
          catch (e) { toast(friendly(e)); }
        } }, "Remove")),
      h("div", { class: "muted", text: `Joined ${fmtDate(m.joined_at)} · ${m.message_count} messages · last active ${ago(m.last_message_at)}` }));
    body.replaceChildren(
      h("p", { class: "muted", text: `${members.length} member${members.length === 1 ? "" : "s"}. Tip: to lock someone out, remove them and then set a new room password.` }),
      h("div", { class: "list" }, members.length ? members.map(row) : [h("p", { class: "muted", text: "No members." })]));
  }

  function tabSettings(room, body) {
    const nameIn = h("input", { value: room.room_name, maxlength: "40" });
    const passIn = h("input", { type: "password", placeholder: "New password (6–72 characters)", maxlength: "72", autocomplete: "new-password" });

    const rename = async () => {
      const n = nameIn.value.trim();
      if (n.length < 2) return toast("Room name must be at least 2 characters");
      try { await rpc("admin_rename_room", { p_room: room.id, p_name: n }); room.room_name = n; toast("Room renamed"); await viewRoom(room); }
      catch (e) { toast(friendly(e)); }
    };
    const setPass = async () => {
      if (passIn.value.length < 6) return toast("Password must be at least 6 characters");
      if (!confirm("Set a new password for this room? Existing members stay in the room.")) return;
      try { await rpc("admin_set_room_password", { p_room: room.id, p_password: passIn.value }); passIn.value = ""; toast("Password updated"); }
      catch (e) { toast(friendly(e)); }
    };
    const clearAll = async () => {
      if (prompt(`This permanently deletes ALL messages in this room.\nType the room name to confirm:\n${room.room_name}`) !== room.room_name) return;
      try { const n = await rpc("admin_clear_room_messages", { p_room: room.id }); room.message_count = 0; toast(`Deleted ${n} messages`); }
      catch (e) { toast(friendly(e)); }
    };
    const delRoom = async () => {
      if (prompt(`This permanently deletes the room, its members and all messages.\nType the room name to confirm:\n${room.room_name}`) !== room.room_name) return;
      try { await rpc("admin_delete_room", { p_room: room.id }); toast("Room deleted"); go("rooms"); }
      catch (e) { toast(friendly(e)); }
    };

    body.replaceChildren(
      h("div", { class: "card" },
        h("label", { text: "Room name / ID" }),
        h("div", { class: "field-row" }, nameIn, h("button", { class: "btn", type: "button", onclick: rename }, "Save")),
        h("label", { text: "Reset room password" }),
        h("div", { class: "field-row" }, passIn, h("button", { class: "btn", type: "button", onclick: setPass }, "Set"))),
      h("div", { class: "card danger-zone", style: "margin-top:14px" },
        h("h3", { text: "Danger zone" }),
        h("p", { class: "muted", text: "These actions cannot be undone." }),
        h("div", { class: "toolbar" },
          h("button", { class: "btn danger", type: "button", onclick: clearAll }, "Clear all messages"),
          h("button", { class: "btn danger", type: "button", onclick: delRoom }, "Delete room"))));
  }

  // ---------------- Search across all rooms ----------------
  function viewSearch() {
    const input = h("input", { type: "search", placeholder: "Search messages or usernames in all rooms…" });
    const out = h("div", { class: "list" });

    async function openRoom(id) {
      try {
        rooms = await rpc("admin_list_rooms");
        const r = rooms.find((x) => x.id === id);
        if (r) go("room", r); else toast("Room no longer exists");
      } catch (e) { toast(friendly(e)); }
    }
    function resultRow(m) {
      return h("div", { class: "msg" },
        h("div", { class: "msg-top" },
          h("button", { class: "room-link", type: "button", onclick: () => openRoom(m.room_id) }, m.room_name),
          h("span", { class: "muted", text: ` · ${m.username} · ${fmtDate(m.created_at)}` }),
          h("button", { class: "btn danger sm", type: "button", onclick: async (ev) => {
            if (!confirm("Delete this message permanently?")) return;
            try { await rpc("admin_delete_message", { p_id: m.id }); ev.target.closest(".msg").remove(); toast("Message deleted"); }
            catch (e) { toast(friendly(e)); }
          } }, "Delete")),
        h("div", { class: "msg-body", text: m.content }));
    }
    async function run(e) {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) { out.replaceChildren(); return; }
      out.replaceChildren(h("p", { class: "muted", text: "Searching…" }));
      try {
        const rows = await rpc("admin_search_messages", { p_query: q, p_limit: 100 });
        out.replaceChildren(...(rows.length ? rows.map(resultRow) : [h("p", { class: "muted", text: "No results." })]));
      } catch (err) { out.replaceChildren(h("p", { class: "error", text: friendly(err) })); }
    }
    view.replaceChildren(
      h("h2", { text: "Search messages" }),
      h("form", { class: "toolbar", onsubmit: run }, input, h("button", { class: "btn", type: "submit" }, "Search")),
      out);
    input.focus();
  }

  // ---------------- Auth ----------------
  async function enter(session) {
    try {
      const ok = await rpc("is_chat_admin");
      if (!ok) { await client.auth.signOut(); showLogin("This account is not an admin. Add it to chat_admins (see admin-setup.sql)."); return; }
      $("who").textContent = (session && session.user && session.user.email) || "";
      showApp();
      go("dashboard");
    } catch (e) { showLogin(friendly(e)); }
  }

  $("login-form").addEventListener("submit", async () => {
    const btn = $("login-btn");
    btn.disabled = true; loginStatus.textContent = "Signing in…";
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: $("email").value.trim(), password: $("password").value });
      if (error) throw error;
      $("password").value = "";
      await enter(data.session);
    } catch (e) { loginStatus.textContent = e.message || "Sign-in failed."; }
    finally { btn.disabled = false; }
  });

  $("signout").addEventListener("click", async () => {
    await client.auth.signOut();
    view.replaceChildren();
    showLogin("");
  });

  (async () => {
    const { data: { session } } = await client.auth.getSession();
    if (!session) showLogin(""); else await enter(session);
  })();
})();
