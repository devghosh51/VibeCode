(() => {
  const $ = (id) => document.getElementById(id);
  const status = (el, msg) => { el.textContent = msg || ""; };
  const validConfig = () =>
    window.SUPABASE_URL && !window.SUPABASE_URL.includes("YOUR-PROJECT") &&
    window.SUPABASE_ANON_KEY && !window.SUPABASE_ANON_KEY.includes("YOUR_");

  let client, currentRoom = null, currentUsername = "", channel = null, presenceChannel = null, currentUserId = null, presenceKey = null;

  const entryCard = $("entry-card"), chatCard = $("chat-card");
  const createForm = $("create-form"), joinForm = $("join-form");

  if (validConfig() && window.supabase) {
    client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  } else {
    status($("entry-status"), "Setup required: add your Supabase URL and anon key in config.js.");
  }

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
    entryCard.classList.add("hidden"); chatCard.classList.remove("hidden");
    await loadMessages();
    subscribeToMessages();
    subscribeToPresence();
    $("message-input").focus();
  }

  async function loadMessages() {
    const { data, error } = await client.from("chat_messages").select("id, room_id, username, content, created_at")
      .eq("room_id", currentRoom).order("created_at", { ascending: true }).limit(100);
    if (error) throw error;
    $("messages").innerHTML = "";
    if (!data.length) showEmpty();
    else data.forEach(renderMessage);
    scrollBottom();
  }

  function showEmpty() {
    $("messages").innerHTML = '<div class="empty-state">No messages yet. Say hello 👋</div>';
  }

  function renderMessage(msg) {
    const box = $("messages");
    const empty = box.querySelector(".empty-state"); if (empty) empty.remove();
    if (box.querySelector(`[data-message-id="${msg.id}"]`)) return;
    const wrap = document.createElement("div");
    wrap.className = "message" + (msg.username === currentUsername ? " mine" : "");
    wrap.dataset.messageId = msg.id;
    const meta = document.createElement("div"); meta.className = "message-meta";
    const date = new Date(msg.created_at);
    meta.textContent = `${msg.username} · ${date.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`;
    const bubble = document.createElement("div"); bubble.className = "bubble"; bubble.textContent = msg.content;
    wrap.append(meta, bubble); box.append(wrap); scrollBottom();
  }

  function subscribeToMessages() {
    if (channel) client.removeChannel(channel);
    channel = client.channel("room-" + currentRoom)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_id=eq.${currentRoom}` },
        (payload) => renderMessage(payload.new))
      .subscribe((state) => { if (state === "CHANNEL_ERROR") status($("chat-status"), "Live connection issue. Refresh the page to reconnect."); });
  }

  function addSystemNotice(text) {
    const box = $("messages");
    const empty = box.querySelector(".empty-state"); if (empty) empty.remove();
    const notice = document.createElement("div");
    notice.className = "system-notice";
    notice.textContent = text;
    box.append(notice);
    scrollBottom();
  }

  function subscribeToPresence() {
    if (presenceChannel) client.removeChannel(presenceChannel);
    presenceKey = `${currentUserId}:${window.crypto?.randomUUID ? crypto.randomUUID() : Date.now() + Math.random()}`;
    presenceChannel = client.channel("room-presence-" + currentRoom, {
      config: { presence: { key: presenceKey } }
    });

    presenceChannel
      .on("presence", { event: "join" }, ({ newPresences }) => {
        (newPresences || []).forEach((person) => {
          if (person.session_key === presenceKey) return;
          addSystemNotice(`${person.username || "Someone"} joined the room`);
        });
      })
      .on("presence", { event: "leave" }, ({ leftPresences }) => {
        (leftPresences || []).forEach((person) => {
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
          else addSystemNotice("You joined the room");
        } else if (state === "CHANNEL_ERROR" || state === "TIMED_OUT") {
          status($("chat-status"), "Live presence connection issue. Refresh the page to reconnect.");
        }
      });
  }

  $("message-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = $("message-input"), content = input.value.trim();
    if (!content || !currentRoom) return;
    const send = $("message-form").querySelector("button[type=submit]"); send.disabled = true;
    try {
      const { error } = await client.from("chat_messages").insert({ room_id: currentRoom, username: currentUsername, content });
      if (error) throw error;
      input.value = ""; status($("chat-status"), "");
    } catch (err) { status($("chat-status"), err.message || "Message could not be sent."); }
    finally { send.disabled = false; input.focus(); }
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
    if (presenceChannel) await client.removeChannel(presenceChannel);
    if (channel) await client.removeChannel(channel);
    presenceChannel = null; channel = null; currentRoom = null; currentUserId = null; presenceKey = null;
    chatCard.classList.add("hidden"); entryCard.classList.remove("hidden");
    $("messages").innerHTML = '<div class="empty-state">No messages yet. Say hello 👋</div>';
    $("message-input").value = ""; status($("chat-status"), "");
  });
  function scrollBottom() { const box = $("messages"); box.scrollTop = box.scrollHeight; }
})();