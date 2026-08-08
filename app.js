(() => {
  "use strict";

  const config = window.BOUQUET_CONFIG || {};
  const { createClient } = window.supabase || {};
  const app = document.getElementById("app");
  const toastContainer = document.getElementById("toast-container");

  if (!createClient) {
    app.innerHTML = '<div class="app-shell"><div class="error-box">Supabaseライブラリを読み込めませんでした。</div></div>';
    return;
  }

  const configured = config.SUPABASE_URL && config.SUPABASE_PUBLISHABLE_KEY &&
    !config.SUPABASE_URL.includes("YOUR_PROJECT_ID") &&
    !config.SUPABASE_PUBLISHABLE_KEY.includes("REPLACE_ME");

  if (!configured) {
    app.innerHTML = `
      <div class="app-shell">
        <header class="app-header"><h1 class="app-title">Bouquet Tool</h1></header>
        <section class="page-body">
          <div class="error-box">config.js に Supabase URL と Publishable Key を設定してください。</div>
          <p class="muted">README.md の「初期設定」を参照してください。</p>
        </section>
      </div>`;
    return;
  }

  const supabaseClient = createClient(config.SUPABASE_URL, config.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const state = {
    authUser: null,
    session: null,
    participant: null,
    participants: [],
    history: [],
    view: "join",
    amount: 1,
    realtime: [],
    opQueue: Promise.resolve(),
    busy: false
  };

  const STORAGE_PREFIX = "bouquet.participant.";
  const toastMap = new Map();

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function roomFromUrl() {
    return (new URLSearchParams(location.search).get("room") || "").trim().toUpperCase();
  }

  function setRoomUrl(roomCode) {
    const url = new URL(location.href);
    if (roomCode) url.searchParams.set("room", roomCode);
    else url.searchParams.delete("room");
    history.replaceState({}, "", url);
  }

  function participantStorageKey(roomCode) {
    return `${STORAGE_PREFIX}${roomCode}`;
  }

  function saveParticipantHint(roomCode, participantId) {
    localStorage.setItem(participantStorageKey(roomCode), participantId);
  }

  function clearParticipantHint(roomCode) {
    localStorage.removeItem(participantStorageKey(roomCode));
  }

  async function ensureAuth() {
    const { data: current } = await supabaseClient.auth.getSession();
    if (current.session?.user) {
      state.authUser = current.session.user;
      return;
    }
    const { data, error } = await supabaseClient.auth.signInAnonymously();
    if (error) throw error;
    state.authUser = data.user;
  }

  function shell(titleText, body, actions = "") {
    return `
      <div class="app-shell">
        <header class="app-header">
          <h1 class="app-title">${escapeHtml(titleText)}</h1>
          ${actions ? `<div class="header-actions">${actions}</div>` : ""}
        </header>
        <section class="page-body">${body}</section>
      </div>`;
  }

  function renderError(message) {
    return `<div class="error-box">${escapeHtml(message)}</div>`;
  }

  function renderJoin(error = "") {
    state.view = "join";
    const room = roomFromUrl();
    app.innerHTML = shell("Bouquet Tool ｜ セッション参加", `
      ${error ? renderError(error) : ""}
      <div class="panel">
        <p class="muted" style="text-align:center;margin-top:0">参加するセッションのコードと表示名を入力してください。</p>
        <form id="join-form" class="form-grid">
          <div class="form-row">
            <label class="form-label" for="room-code">セッションコード</label>
            <input id="room-code" class="input" maxlength="12" autocomplete="off" value="${escapeHtml(room)}" placeholder="例：ABCD1234" required />
          </div>
          <div class="form-row">
            <label class="form-label" for="display-name">表示名</label>
            <input id="display-name" class="input" maxlength="40" autocomplete="nickname" placeholder="例：もにょもにょ" required />
          </div>
          <div class="button-row">
            <button class="primary-button" type="submit">セッションへ参加</button>
            <button id="go-create" class="secondary-button" type="button">新しいセッションを作成</button>
          </div>
        </form>
      </div>
      <p class="small muted">参加URLから開いた場合はセッションコードを自動入力します。同じブラウザでは保存済み参加者として復帰します。</p>
    `);

    document.getElementById("go-create").addEventListener("click", () => renderCreate());
    document.getElementById("join-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const code = document.getElementById("room-code").value.trim().toUpperCase();
      const name = document.getElementById("display-name").value.trim();
      if (!code || !name) return;
      setBusyButton(e.submitter, true, "参加中…");
      try {
        await joinSession(code, name);
      } catch (err) {
        console.error(err);
        renderJoin(readableError(err));
      }
    });
  }

  function renderCreate(error = "", created = null) {
    state.view = "create";
    const createdBlock = created ? `
      <div class="panel">
        <h2 class="panel-title">作成後に自動生成される情報</h2>
        <div class="management-grid">
          <div class="management-row">
            <div class="form-label">セッションコード</div>
            <div class="input display-field">${escapeHtml(created.room_code)}</div>
            <button class="secondary-button copy-button" data-copy="${escapeHtml(created.room_code)}">コピー</button>
          </div>
          <div class="management-row">
            <div class="form-label">参加URL</div>
            <div class="input display-field">${escapeHtml(created.share_url)}</div>
            <button class="secondary-button copy-button" data-copy="${escapeHtml(created.share_url)}">コピー</button>
          </div>
        </div>
        <div class="button-row"><button id="enter-created" class="primary-button">セッションへ入る</button></div>
      </div>` : "";

    app.innerHTML = shell("Bouquet Tool ｜ セッション作成", `
      ${error ? renderError(error) : ""}
      <div class="panel">
        <form id="create-form" class="form-grid">
          <div class="form-row">
            <label class="form-label" for="session-name">セッション名</label>
            <input id="session-name" class="input" maxlength="80" placeholder="例：○○卓" value="${escapeHtml(created?.session_name || "")}" required ${created ? "disabled" : ""} />
          </div>
          <div class="form-row">
            <label class="form-label" for="gm-name">GM表示名</label>
            <input id="gm-name" class="input" maxlength="40" placeholder="例：GM" value="${escapeHtml(created?.gm_name || "")}" required ${created ? "disabled" : ""} />
          </div>
          ${created ? "" : '<div class="button-row"><button class="primary-button" type="submit">セッションを作成</button><button id="back-join" class="secondary-button" type="button">参加画面へ戻る</button></div>'}
        </form>
      </div>
      ${createdBlock}
      <p class="small muted">コードとURLはシステムが自動生成し、利用者は編集できません。</p>
    `);

    if (!created) {
      document.getElementById("back-join").addEventListener("click", () => renderJoin());
      document.getElementById("create-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const sessionName = document.getElementById("session-name").value.trim();
        const gmName = document.getElementById("gm-name").value.trim();
        setBusyButton(e.submitter, true, "作成中…");
        try {
          const result = await createSession(sessionName, gmName);
          renderCreate("", { ...result, session_name: sessionName, gm_name: gmName });
        } catch (err) {
          console.error(err);
          renderCreate(readableError(err));
        }
      });
    } else {
      bindCopyButtons();
      document.getElementById("enter-created").addEventListener("click", async () => {
        await loadCurrentSession(created.room_code);
        renderMain();
      });
    }
  }

  function renderMain(error = "") {
    state.view = "main";
    const isOwner = state.session?.is_owner === true;
    const actions = `
      <button id="open-history" class="header-button">履歴</button>
      ${isOwner ? '<button id="open-management" class="header-button">セッション管理</button>' : ""}`;

    const cards = state.participants.map((p) => {
      const self = p.id === state.participant.id;
      return `
        <article class="participant-card ${self ? "self" : ""}">
          <div class="participant-name">${escapeHtml(p.display_name)}${self ? "（自分）" : ""}</div>
          <div class="bouquet-count"><span>ブーケ</span><strong>${p.balance}</strong></div>
          <button class="primary-button action-button bouquet-action" data-target="${p.id}" data-mode="${self ? "use" : "throw"}">${self ? "使う" : "投げる"}</button>
        </article>`;
    }).join("");

    app.innerHTML = shell(`Bouquet Tool ｜ ${state.session.name}`, `
      ${error ? renderError(error) : ""}
      <div class="main-toolbar">
        <div class="login-chip">ログイン中：${escapeHtml(state.participant.display_name)}</div>
        <label class="amount-control">ブーケ数
          <input id="bouquet-amount" class="input amount-input" type="number" min="1" max="999" step="1" inputmode="numeric" value="${state.amount}" />
        </label>
      </div>
      <div class="participant-grid">${cards || '<div class="empty">参加者がいません。</div>'}</div>
      <div class="session-total"><span>セッション全体のブーケ</span><strong>${state.session.total_balance}</strong></div>
    `, actions);

    document.getElementById("open-history").addEventListener("click", async () => {
      await loadHistory();
      renderHistory();
    });
    if (isOwner) document.getElementById("open-management").addEventListener("click", () => renderManagement());
    document.getElementById("bouquet-amount").addEventListener("change", (e) => {
      const n = Math.max(1, Math.min(999, Number.parseInt(e.target.value, 10) || 1));
      state.amount = n;
      e.target.value = n;
    });
    document.querySelectorAll(".bouquet-action").forEach((button) => {
      button.addEventListener("click", () => enqueueBouquetAction(button.dataset.mode, button.dataset.target));
    });
  }

  function renderHistory(error = "") {
    state.view = "history";
    const rows = state.history.map((h) => `
      <tr>
        <td>${escapeHtml(formatDateTime(h.created_at))}</td>
        <td>${escapeHtml(h.actor_name)}</td>
        <td>${escapeHtml(h.action_type === "use" ? "使用" : h.target_name)}</td>
        <td>${h.amount}</td>
      </tr>`).join("");

    app.innerHTML = shell("Bouquet Tool ｜ ブーケ履歴", `
      ${error ? renderError(error) : ""}
      <div class="panel"><strong>セッション：${escapeHtml(state.session.name)}</strong> <span class="muted">｜ ログイン中：${escapeHtml(state.participant.display_name)}</span></div>
      <div class="panel">
        <h2 class="panel-title">ブーケ履歴</h2>
        <div class="history-scroll">
          <table class="history-table">
            <thead><tr><th>日時</th><th>操作した人</th><th>宛先</th><th>ブーケ</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="4" class="empty">履歴はまだありません。</td></tr>'}</tbody>
          </table>
        </div>
        <div class="button-row">
          <button id="export-csv" class="primary-button">CSV出力</button>
          <button id="history-back" class="secondary-button">メイン画面へ戻る</button>
        </div>
      </div>
    `);

    document.getElementById("history-back").addEventListener("click", () => renderMain());
    document.getElementById("export-csv").addEventListener("click", exportHistoryCsv);
  }

  function renderManagement(error = "") {
    if (!state.session?.is_owner) return renderMain("セッション管理は作成者のみ利用できます。");
    state.view = "management";
    const shareUrl = buildShareUrl(state.session.room_code);
    const migratable = state.participants.filter((p) => p.id !== state.participant.id);
    const migrationOptions = state.participants.map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(`${p.display_name}｜ブーケ ${p.balance}｜ID ${p.id.slice(0, 4)}`)}</option>`
    ).join("");
    const sourceOptions = migratable.map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(`${p.display_name}｜ブーケ ${p.balance}｜ID ${p.id.slice(0, 4)}`)}</option>`
    ).join("");

    app.innerHTML = shell("Bouquet Tool ｜ セッション管理", `
      ${error ? renderError(error) : ""}
      <div class="panel">
        <div class="management-grid">
          <div class="management-row">
            <div class="form-label">セッション名</div>
            <input id="management-name" class="input" maxlength="80" value="${escapeHtml(state.session.name)}" />
            <button id="rename-session" class="secondary-button">名前を変更</button>
          </div>
          <div class="management-row">
            <div class="form-label">セッションコード</div>
            <div class="input display-field">${escapeHtml(state.session.room_code)}</div>
            <button class="secondary-button copy-button" data-copy="${escapeHtml(state.session.room_code)}">コピー</button>
          </div>
          <div class="management-row">
            <div class="form-label">参加URL</div>
            <div class="input display-field">${escapeHtml(shareUrl)}</div>
            <button class="secondary-button copy-button" data-copy="${escapeHtml(shareUrl)}">コピー</button>
          </div>
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-title">管理操作</h2>
        <div class="button-row">
          <button id="management-history" class="primary-button">履歴を表示</button>
          <button id="management-csv" class="primary-button">CSV出力</button>
        </div>
      </div>
      <div class="panel">
        <h2 class="panel-title">参加者カード移行</h2>
        <p class="muted small">キャッシュクリア等で同じ参加者のカードが増えた場合に、旧カードの現在ブーケを新カードへ引き継ぎます。過去の履歴は残ります。</p>
        ${migratable.length ? `
          <div class="migration-grid">
            <label class="form-label" for="migration-source">移行元</label>
            <select id="migration-source" class="input">${sourceOptions}</select>
            <label class="form-label" for="migration-target">移行先</label>
            <select id="migration-target" class="input">${migrationOptions}</select>
          </div>
          <div class="button-row"><button id="migrate-card" class="secondary-button">カードを移行</button></div>
        ` : '<div class="empty">移行できる別カードがありません。</div>'}
      </div>
      <div class="panel danger-zone">
        <h2 class="panel-title">セッション終了</h2>
        <p class="muted small">セッションを終了すると、参加者・ブーケ・履歴を含むセッションデータを削除します。必要な場合は先にCSVを出力してください。</p>
        <div class="button-row"><button id="end-session" class="danger-button">セッションを終了</button></div>
      </div>
      <div class="button-row"><button id="management-back" class="secondary-button">メイン画面へ戻る</button></div>
    `);

    bindCopyButtons();
    document.getElementById("management-back").addEventListener("click", () => renderMain());
    document.getElementById("management-history").addEventListener("click", async () => { await loadHistory(); renderHistory(); });
    document.getElementById("management-csv").addEventListener("click", async () => { await loadHistory(); exportHistoryCsv(); });
    document.getElementById("rename-session").addEventListener("click", async (e) => {
      const name = document.getElementById("management-name").value.trim();
      if (!name) return;
      setBusyButton(e.currentTarget, true, "変更中…");
      try {
        const { error } = await supabaseClient.rpc("rename_bouquet_session", { p_session_id: state.session.id, p_name: name });
        if (error) throw error;
        state.session.name = name;
        showToast("management:rename", "セッション名を変更しました", { aggregate: false });
        renderManagement();
      } catch (err) {
        renderManagement(readableError(err));
      }
    });

    const migrateButton = document.getElementById("migrate-card");
    if (migrateButton) migrateButton.addEventListener("click", async (e) => {
      const sourceId = document.getElementById("migration-source").value;
      const targetId = document.getElementById("migration-target").value;
      if (sourceId === targetId) return renderManagement("移行元と移行先には別のカードを選択してください。");
      const source = state.participants.find((p) => p.id === sourceId);
      const target = state.participants.find((p) => p.id === targetId);
      if (!source || !target) return renderManagement("移行するカードを確認できませんでした。");
      const after = Number(source.balance) + Number(target.balance);
      const ok = confirm(
        `「${source.display_name}」（ブーケ ${source.balance}）を「${target.display_name}」（ブーケ ${target.balance}）へ移行します。\n` +
        `移行後のブーケは ${after} になります。移行元カードは画面から消えます。\n` +
        `この操作は元に戻せません。実行しますか？`
      );
      if (!ok) return;
      setBusyButton(e.currentTarget, true, "移行中…");
      try {
        const { error } = await supabaseClient.rpc("migrate_bouquet_participant", {
          p_session_id: state.session.id,
          p_source_participant_id: sourceId,
          p_target_participant_id: targetId
        });
        if (error) throw error;
        await refreshState();
        showToast("management:migrate", "カードを移行しました", { aggregate: false });
        renderManagement();
      } catch (err) {
        renderManagement(readableError(err));
      }
    });

    document.getElementById("end-session").addEventListener("click", async (e) => {
      if (!confirm("セッションを終了すると、参加者・ブーケ・履歴がすべて削除され、元に戻せません。必要な場合は先にCSVを出力してください。\n\nセッションを終了しますか？")) return;
      setBusyButton(e.currentTarget, true, "削除中…");
      const roomCode = state.session.room_code;
      try {
        const { error } = await supabaseClient.rpc("delete_bouquet_session", { p_session_id: state.session.id });
        if (error) throw error;
        clearRealtime();
        clearParticipantHint(roomCode);
        state.session = null;
        state.participant = null;
        state.participants = [];
        state.history = [];
        setRoomUrl("");
        showToast("management:end", "セッションを終了しました", { aggregate: false });
        renderJoin();
      } catch (err) {
        renderManagement(readableError(err));
      }
    });
  }

  function setBusyButton(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      button.textContent = button.dataset.originalText || button.textContent;
      button.disabled = false;
    }
  }

  async function createSession(name, gmDisplayName) {
    await ensureAuth();
    const { data, error } = await supabaseClient.rpc("create_bouquet_session", {
      p_name: name,
      p_gm_display_name: gmDisplayName
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error("セッション作成結果を取得できませんでした。");
    setRoomUrl(result.room_code);
    saveParticipantHint(result.room_code, result.participant_id);
    return { ...result, share_url: buildShareUrl(result.room_code) };
  }

  async function joinSession(roomCode, displayName) {
    await ensureAuth();
    const { data, error } = await supabaseClient.rpc("join_bouquet_session", {
      p_room_code: roomCode,
      p_display_name: displayName
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result) throw new Error("セッションに参加できませんでした。");
    setRoomUrl(result.room_code);
    saveParticipantHint(result.room_code, result.participant_id);
    await loadCurrentSession(result.room_code);
    renderMain();
  }

  async function tryResume(roomCode) {
    if (!roomCode) return false;
    await ensureAuth();
    const { data, error } = await supabaseClient.rpc("resume_bouquet_session", { p_room_code: roomCode });
    if (error || !data || (Array.isArray(data) && data.length === 0)) return false;
    const result = Array.isArray(data) ? data[0] : data;
    if (!result?.participant_id) return false;
    saveParticipantHint(roomCode, result.participant_id);
    await loadCurrentSession(roomCode);
    return true;
  }

  async function loadCurrentSession(roomCode) {
    clearRealtime();
    const { data, error } = await supabaseClient.rpc("get_bouquet_session_state", { p_room_code: roomCode });
    if (error) throw error;
    if (!data?.session || !data?.me) throw new Error("セッション情報を取得できませんでした。");
    state.session = data.session;
    state.participant = data.me;
    state.participants = data.participants || [];
    subscribeRealtime();
  }

  async function refreshState() {
    if (!state.session?.room_code) return;
    const { data, error } = await supabaseClient.rpc("get_bouquet_session_state", { p_room_code: state.session.room_code });
    if (error) throw error;
    state.session = data.session;
    state.participant = data.me;
    state.participants = data.participants || [];
    if (state.view === "main") renderMain();
  }

  async function loadHistory() {
    if (!state.session) return;
    const { data, error } = await supabaseClient.rpc("get_bouquet_history", { p_session_id: state.session.id, p_limit: 2000 });
    if (error) throw error;
    state.history = data || [];
  }

  function enqueueBouquetAction(mode, targetId) {
    const amountInput = document.getElementById("bouquet-amount");
    const amount = Math.max(1, Math.min(999, Number.parseInt(amountInput?.value, 10) || state.amount || 1));
    state.amount = amount;
    if (amountInput) amountInput.value = amount;

    state.opQueue = state.opQueue
      .then(() => performBouquetAction(mode, targetId, amount))
      .catch((err) => {
        console.error(err);
        showToast(`error:${Date.now()}`, readableError(err), { error: true, aggregate: false });
      });
  }

  async function performBouquetAction(mode, targetId, amount) {
    if (state.session.status !== "active") throw new Error("このセッションは終了しています。");
    const requestId = crypto.randomUUID();
    const { data, error } = await supabaseClient.rpc("perform_bouquet_action", {
      p_session_id: state.session.id,
      p_target_participant_id: targetId,
      p_action_type: mode,
      p_amount: amount,
      p_request_id: requestId
    });
    if (error) throw error;

    const target = state.participants.find((p) => p.id === targetId);
    if (mode === "use") {
      showToast("use:self", `💐 ${amount} 使用しました`, { amount, aggregate: true, prefix: "💐 ", suffix: " 使用しました" });
    } else {
      showToast(`throw:${targetId}`, `💐 ${target?.display_name || "相手"} に ${amount} 投げました`, {
        amount, aggregate: true, prefix: `💐 ${target?.display_name || "相手"} に `, suffix: " 投げました"
      });
    }

    // Realtimeでも更新されるが、操作端末は即時に同期する。
    await refreshState();
    return data;
  }

  function subscribeRealtime() {
    if (!state.session) return;
    const eventChannel = supabaseClient
      .channel(`bouquet-events:${state.session.id}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "bouquet_events",
        filter: `session_id=eq.${state.session.id}`
      }, async () => {
        try {
          await refreshState();
          if (state.view === "history") { await loadHistory(); renderHistory(); }
        } catch (err) { console.error(err); }
      })
      .subscribe();

    const participantChannel = supabaseClient
      .channel(`bouquet-participants:${state.session.id}`)
      .on("postgres_changes", {
        event: "*",
        schema: "public",
        table: "bouquet_participants",
        filter: `session_id=eq.${state.session.id}`
      }, async () => {
        try {
          await refreshState();
          if (state.view === "history") { await loadHistory(); renderHistory(); }
        } catch (err) { console.error(err); }
      })
      .subscribe();

    const sessionChannel = supabaseClient
      .channel(`bouquet-session:${state.session.id}`)
      .on("postgres_changes", {
        event: "UPDATE",
        schema: "public",
        table: "bouquet_sessions",
        filter: `id=eq.${state.session.id}`
      }, async () => {
        try { await refreshState(); } catch (err) { console.error(err); }
      })
      .subscribe();

    state.realtime.push(eventChannel, participantChannel, sessionChannel);
  }

  function clearRealtime() {
    state.realtime.forEach((channel) => supabaseClient.removeChannel(channel));
    state.realtime = [];
  }

  function showToast(key, text, options = {}) {
    const { error = false, aggregate = false, amount = 0, prefix = "", suffix = "" } = options;
    let item = toastMap.get(key);
    if (!item) {
      const el = document.createElement("div");
      el.className = `toast${error ? " error" : ""}`;
      toastContainer.prepend(el);
      item = { el, total: 0, timer: null };
      toastMap.set(key, item);
      requestAnimationFrame(() => el.classList.add("visible"));
    }
    if (aggregate) {
      item.total += amount;
      item.el.textContent = `${prefix}${item.total}${suffix}`;
    } else {
      item.el.textContent = text;
    }
    clearTimeout(item.timer);
    item.timer = setTimeout(() => {
      item.el.classList.remove("visible");
      setTimeout(() => item.el.remove(), 180);
      toastMap.delete(key);
    }, 1050);

    while (toastContainer.children.length > 3) {
      const last = toastContainer.lastElementChild;
      if (!last) break;
      const mapEntry = [...toastMap.entries()].find(([, v]) => v.el === last);
      if (mapEntry) toastMap.delete(mapEntry[0]);
      last.remove();
    }
  }

  function exportHistoryCsv() {
    if (!state.history.length) return showToast("csv:none", "出力する履歴がありません", { error: true, aggregate: false });
    const rows = [["日時", "操作した人", "宛先", "ブーケ"]];
    for (const h of state.history) {
      rows.push([
        formatDateTime(h.created_at),
        h.actor_name,
        h.action_type === "use" ? "使用" : h.target_name,
        h.amount
      ]);
    }
    const csv = "\uFEFF" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bouquet_${state.session.room_code}_${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function csvEscape(v) {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  }

  function formatDateTime(value) {
    const d = new Date(value);
    return new Intl.DateTimeFormat("ja-JP", {
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false
    }).format(d);
  }

  function buildShareUrl(roomCode) {
    const url = new URL(location.href);
    url.search = "";
    url.hash = "";
    url.searchParams.set("room", roomCode);
    return url.toString();
  }

  function bindCopyButtons() {
    document.querySelectorAll(".copy-button").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.copy || "");
          showToast(`copy:${button.dataset.copy}`, "コピーしました", { aggregate: false });
        } catch {
          showToast("copy:error", "コピーできませんでした", { error: true, aggregate: false });
        }
      });
    });
  }

  function readableError(err) {
    const message = err?.message || String(err || "エラーが発生しました。");
    const mapping = [
      ["SESSION_NOT_FOUND", "セッションが見つかりません。"],
      ["SESSION_ENDED", "このセッションは終了しています。"],
      ["NOT_SESSION_MEMBER", "このセッションへ参加していません。"],
      ["NOT_SESSION_OWNER", "この操作はセッション作成者のみ実行できます。"],
      ["INVALID_TARGET", "投げ先が正しくありません。"],
      ["CANNOT_THROW_TO_SELF", "自分にはブーケを投げられません。"],
      ["INSUFFICIENT_BOUQUET", "ブーケが足りません。"],
      ["PARTICIPANT_MIGRATED", "この参加者カードは別のカードへ移行済みです。"],
      ["INVALID_MIGRATION", "カード移行の指定が正しくありません。"],
      ["INVALID_AMOUNT", "ブーケ数は1～999で指定してください。"],
      ["DISPLAY_NAME_REQUIRED", "表示名を入力してください。"],
      ["SESSION_NAME_REQUIRED", "セッション名を入力してください。"]
    ];
    const hit = mapping.find(([code]) => message.includes(code));
    return hit ? hit[1] : message;
  }

  async function bootstrap() {
    app.innerHTML = shell("Bouquet Tool", '<div class="loading">読み込み中…</div>');
    try {
      await ensureAuth();
      const room = roomFromUrl();
      if (room && await tryResume(room)) {
        renderMain();
      } else {
        renderJoin();
      }
    } catch (err) {
      console.error(err);
      renderJoin(readableError(err));
    }
  }

  window.addEventListener("beforeunload", clearRealtime);
  bootstrap();
})();
