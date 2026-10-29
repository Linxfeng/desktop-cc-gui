/* ===========================================================================
 * 用量与限额 · 设计稿交互：状态、事件委托、浮层定位、反馈动画、URL hash。
 * 不可变更新：每次 set() 生成新的 state 对象再整体重绘。
 * ======================================================================== */
(function () {
  "use strict";
  const D = window.ULData;
  const V = window.ULViews;
  const $ = (sel) => document.querySelector(sel);

  const INITIAL = {
    view: "statusbar",
    dark: false, tight: false, running: false, scanning: false, empty: false, reduced: false, pins: false,
    claude: "ok", codex: "ok",
    popover: true, centerTab: "chat", usageTabOpen: false, page: "overview",
    layer: null, drawer: null, draft: null, calMonth: D.keyOf(D.startOfMonth(D.TODAY)),
    chipMode: "both", chipPeriod: "today", mascot: true, mascotMotion: true, chipAlert: true,
    limitMode: "used", autoRefresh: "5",
    alerts: { on: true, thresholds: [80, 95], background: false },
    providers: { claude: true, codex: true },
    priceAuto: true,
    sources: Object.fromEntries(D.SOURCES.map((src) => [src.id, true])),
    collapsed: { claude: false, codex: false },
    period: "month", anchor: D.keyOf(D.TODAY), range: null,
    engine: null, trendBy: "engine", table: "time",
    sort: { time: { key: "key", dir: "desc" }, project: { key: "total", dir: "desc" }, model: { key: "total", dir: "desc" } },
    modelsOpen: false,
    ago: { usage: 120, scan: 40 },
    rescan: null, flashWs: null,
  };

  const VIEWS = {
    statusbar: { popover: true, centerTab: "chat", layer: null, drawer: null },
    dashboard: { popover: false, centerTab: "usage", usageTabOpen: true, page: "overview", layer: null },
    limits: { popover: false, centerTab: "usage", usageTabOpen: true, page: "limits", layer: null, drawer: null },
    settings: { popover: false, centerTab: "settings", layer: null, drawer: null },
  };
  const VIEW_KEYS = Object.keys(VIEWS);
  const HASH_BOOLS = ["dark", "tight", "running", "scanning", "empty", "reduced", "pins"];

  let state = INITIAL;
  let renderCount = 0;
  let notesView = null;

  /* ------------------------------------------------------------ 状态工具 */
  function set(patch) {
    state = { ...state, ...patch };
    render();
  }
  function silent(patch) {
    state = { ...state, ...patch };
  }
  function setPath(obj, path, value) {
    const [head, ...rest] = path;
    return { ...obj, [head]: rest.length ? setPath(obj[head], rest, value) : value };
  }
  const getPath = (obj, path) => path.reduce((o, k) => (o == null ? o : o[k]), obj);
  const go = (view) => set({ ...VIEWS[view], view });

  /* ------------------------------------------------------------ hash */
  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    const patch = {};
    const view = params.get("view");
    if (VIEW_KEYS.includes(view)) Object.assign(patch, VIEWS[view], { view });
    HASH_BOOLS.forEach((k) => { if (params.get(k) === "1") patch[k] = true; });
    ["claude", "codex", "period", "page"].forEach((k) => { if (params.get(k)) patch[k] = params.get(k); });
    if (params.get("mode")) patch.limitMode = params.get("mode");
    if (params.get("engine")) patch.engine = params.get("engine");
    if (params.get("popover") === "1") patch.popover = true;
    if (["range", "sources", "bell"].includes(params.get("layer"))) patch.layer = params.get("layer");
    if (patch.layer === "range") patch.draft = { from: D.keyOf(D.addDays(D.TODAY, -29)), to: D.keyOf(D.TODAY) };
    if (D.PROJECT[params.get("drawer")]) patch.drawer = params.get("drawer");
    return patch;
  }
  function writeHash() {
    const params = new URLSearchParams();
    params.set("view", state.view);
    HASH_BOOLS.forEach((k) => { if (state[k]) params.set(k, "1"); });
    if (state.claude !== "ok") params.set("claude", state.claude);
    if (state.codex !== "ok") params.set("codex", state.codex);
    if (state.layer) params.set("layer", state.layer);
    if (state.drawer) params.set("drawer", state.drawer);
    history.replaceState(null, "", `#${params.toString()}`);
  }

  /* ------------------------------------------------------------ 渲染 */
  function focusKey(el) {
    if (!el || !el.closest || !el.closest("#app") || !el.dataset || !el.dataset.action) return null;
    return Object.keys(el.dataset).sort()
      .map((k) => `[data-${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}="${CSS.escape(el.dataset[k])}"]`).join("");
  }

  function syncReview() {
    document.querySelectorAll("[data-view]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === state.view)));
    document.querySelectorAll("[data-toggle]").forEach((b) => b.setAttribute("aria-pressed", String(!!state[b.dataset.toggle])));
    document.querySelectorAll("[data-select]").forEach((s) => { s.value = state[s.dataset.select]; });
  }

  function render() {
    renderCount += 1;
    const root = document.documentElement;
    root.classList.toggle("dark", state.dark);
    root.classList.toggle("reduced", state.reduced);
    root.classList.toggle("pins", state.pins);
    root.dataset.view = state.view;
    syncReview();
    const fk = focusKey(document.activeElement);
    hideTip();
    V.resetTips();
    $("#side").innerHTML = V.sidebar(state);
    $("#tabs").innerHTML = V.tabs(state);
    $("#center").innerHTML = V.center(state);
    $("#status").innerHTML = V.statusbar(state);
    $("#layer").innerHTML = V.layer(state);
    if (notesView !== state.view) {
      $("#notes").innerHTML = window.ULNotes.render(state.view);
      notesView = state.view;
    }
    positionLayers();
    const el = fk && document.querySelector(fk);
    if (el) el.focus({ preventScroll: true });
    writeHash();
  }

  function positionLayers() {
    const app = $("#app").getBoundingClientRect();
    const pop = $("#pop");
    const chip = $("[data-chip]");
    if (pop && chip) {
      const r = chip.getBoundingClientRect();
      pop.style.left = `${Math.max(8, r.left - app.left - 4)}px`;
      pop.style.bottom = `${app.bottom - r.top + 6}px`;
    }
    document.querySelectorAll(".lay").forEach((lay) => {
      const anchor = $(`[data-layer-anchor="${lay.dataset.layerFor}"]`);
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      const w = lay.offsetWidth;
      const left = r.left - app.left + w > app.width - 12 ? r.right - app.left - w : r.left - app.left;
      lay.style.left = `${Math.max(12, left)}px`;
      lay.style.top = `${r.bottom - app.top + 6}px`;
    });
    const c = $("#center").getBoundingClientRect();
    document.querySelectorAll(".drawer, .drawer-scrim").forEach((el) => {
      el.style.top = `${c.top - app.top}px`;
      el.style.height = `${c.height}px`;
      if (el.classList.contains("drawer-scrim")) {
        el.style.left = `${c.left - app.left}px`;
        el.style.width = `${c.width}px`;
      }
    });
  }

  /* ------------------------------------------------------------ 提示气泡 */
  const tipEl = () => $("#tip");
  function showTip(el) {
    const html = V.tips.get(el.dataset.tip);
    if (!html) return;
    const t = tipEl();
    t.innerHTML = html;
    t.hidden = false;
    const r = el.getBoundingClientRect();
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    const left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    const top = r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8;
    t.style.left = `${left}px`;
    t.style.top = `${top}px`;
  }
  function hideTip() {
    const t = tipEl();
    if (t) t.hidden = true;
  }

  /* ------------------------------------------------------------ 反馈 */
  const SPIN_MS = 600;
  const DONE_MS = 900;

  function flashDone(selector) {
    const el = $(selector);
    if (!el) return;
    el.classList.add("is-done");
    setTimeout(() => el.classList.remove("is-done"), DONE_MS);
  }

  /** 刷新：至少转满一圈；成功换对号 900ms，失败直接复位（UI 规范 §4.1）。 */
  function runRefresh(key) {
    const btn = $(`[data-refresh="${key}"]`);
    if (!btn || btn.classList.contains("is-running")) return;
    btn.classList.add("is-running");
    btn.setAttribute("aria-busy", "true");
    const work = 700 + Math.random() * 700;
    const spin = Math.ceil(work / SPIN_MS) * SPIN_MS;
    const limitsTouched = key === "pop" || key === "limits";
    const failing = limitsTouched && ["claude", "codex"].some((id) => state.providers[id] && ["offline", "rateLimited"].includes(state[id]));
    setTimeout(() => {
      if (failing) {
        const b = $(`[data-refresh="${key}"]`);
        if (b) { b.classList.remove("is-running"); b.removeAttribute("aria-busy"); }
        return;
      }
      const ago = { ...state.ago };
      if (key !== "limits") ago.usage = 0;
      if (limitsTouched) {
        ["claude", "codex"].forEach((id) => { if (state[id] === "ok" || state[id] === "weekly") ago[id] = 0; });
      }
      set({ ago });
      flashDone(`[data-refresh="${key}"]`);
    }, spin);
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return Promise.resolve(fallbackCopy(text));
  }
  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (!ok) throw new Error("copy failed");
  }

  function startRescan() {
    if (state.rescan != null) return;
    set({ rescan: 0 });
    const timer = setInterval(() => {
      const next = Math.min(100, state.rescan + 7);
      if (next >= 100) {
        clearInterval(timer);
        set({ rescan: null, ago: { ...state.ago, scan: 0, usage: 0 } });
        return;
      }
      set({ rescan: next });
    }, 140);
  }

  /* ------------------------------------------------------------ 折叠（不重绘，保留过渡） */
  function toggleCard(id) {
    const card = $(`[data-card="${id}"]`);
    const collapsed = !state.collapsed[id];
    silent({ collapsed: { ...state.collapsed, [id]: collapsed } });
    if (!card) return;
    card.classList.toggle("is-collapsed", collapsed);
    card.querySelector(".pcard__head").setAttribute("aria-expanded", String(!collapsed));
    const body = card.querySelector(".pcard__body");
    if (collapsed) { body.setAttribute("aria-hidden", "true"); body.setAttribute("inert", ""); }
    else { body.removeAttribute("aria-hidden"); body.removeAttribute("inert"); }
  }

  function toggleModels(btn) {
    const box = $('[data-collapse="models"]');
    const open = !state.modelsOpen;
    silent({ modelsOpen: open });
    if (!box) return;
    box.classList.toggle("is-open", open);
    if (open) { box.removeAttribute("aria-hidden"); box.removeAttribute("inert"); }
    else { box.setAttribute("aria-hidden", "true"); box.setAttribute("inert", ""); }
    btn.setAttribute("aria-expanded", String(open));
    const total = box.querySelectorAll("li").length + 5;
    btn.firstChild.textContent = open ? "收起" : `展开全部（${total}）`;
    btn.querySelector("svg").classList.toggle("is-flip", open);
  }

  /* ------------------------------------------------------------ 日期区间 */
  function openRange() {
    const base = state.range || { from: D.keyOf(D.addDays(D.TODAY, -29)), to: D.keyOf(D.TODAY) };
    set({ layer: state.layer === "range" ? null : "range", draft: { ...base }, calMonth: D.keyOf(D.startOfMonth(D.fromKey(base.to))) });
  }
  function pickDay(k) {
    const d = state.draft;
    const next = !d.from || d.to || k < d.from ? { from: k, to: null } : { from: d.from, to: k };
    set({ draft: next });
  }
  function presetRange(v) {
    const from = v === "ytd" ? new Date(D.TODAY.getFullYear(), 0, 1) : D.addDays(D.TODAY, -(Number(v) - 1));
    set({ period: "custom", range: { from: D.keyOf(from), to: D.keyOf(D.TODAY) }, layer: null, draft: null });
  }

  /* ------------------------------------------------------------ 动作表 */
  const openUsage = (page, extra = {}) => set({
    popover: false, usageTabOpen: true, centerTab: "usage", page, layer: null,
    view: page === "limits" ? "limits" : "dashboard", ...extra,
  });

  const TEXT_KEYS = ["key", "name", "model", "engine", "last"];

  const ACTIONS = {
    view: (el) => go(el.dataset.view),
    toggle: (el) => set({ [el.dataset.toggle]: !state[el.dataset.toggle] }),
    "toggle-popover": () => {
      const open = !state.popover;
      set({ popover: open, view: open ? "statusbar" : state.view });
      if (open && state.ago.usage > 60 && !state.scanning && !state.empty) runRefresh("pop");
    },
    "open-usage": (el) => openUsage(el.dataset.page || "overview"),
    "goto-period": (el) => {
      const p = el.dataset.period;
      const rolling = (n) => ({ period: "custom", range: { from: D.keyOf(D.addDays(D.TODAY, -(n - 1))), to: D.keyOf(D.TODAY) } });
      const patch = p === "day" ? { period: "day", anchor: D.keyOf(D.TODAY), range: null }
        : p === "7d" ? rolling(7) : p === "30d" ? rolling(30) : { period: "all", range: null };
      openUsage("overview", patch);
    },
    tab: (el) => {
      const usage = el.dataset.tab === "usage";
      set({ centerTab: el.dataset.tab, layer: null, drawer: null, view: usage ? (state.page === "limits" ? "limits" : "dashboard") : "statusbar" });
    },
    "close-usage": () => set({ usageTabOpen: false, centerTab: "chat", layer: null, drawer: null, view: "statusbar" }),
    page: (el) => set({ page: el.dataset.page, layer: null, drawer: null, view: el.dataset.page === "limits" ? "limits" : "dashboard" }),
    period: (el) => {
      const p = el.dataset.period;
      if (p === "custom") { openRange(); return; }
      const anchor = state.period === "custom" && state.range ? state.range.to : state.anchor;
      set({ period: p, anchor: p === "all" ? D.keyOf(D.TODAY) : anchor, range: null, layer: null });
    },
    nav: (el) => set({ anchor: D.shiftAnchor(state.period, state.anchor, Number(el.dataset.dir)) }),
    "nav-today": () => set({ anchor: D.keyOf(D.TODAY) }),
    engine: (el) => {
      const id = el.dataset.engine || null;
      set({ engine: id && state.engine === id ? null : id });
    },
    "trend-by": (el) => set({ trendBy: el.dataset.by }),
    drill: (el) => {
      const [kind, key] = el.dataset.drill.split(":");
      if (kind === "day") set({ period: "day", anchor: key, range: null, drawer: null });
      else if (kind === "month") set({ period: "month", anchor: key, range: null });
      else if (kind === "week") {
        const to = D.minDate(D.addDays(D.fromKey(key), 6), D.TODAY);
        set({ period: "custom", range: { from: key, to: D.keyOf(to) } });
      }
    },
    table: (el) => {
      set({ table: el.dataset.table });
      if (el.closest(".hero")) $("#dtable").scrollIntoView({ behavior: state.reduced ? "auto" : "smooth", block: "start" });
    },
    sort: (el) => {
      const key = el.dataset.sort;
      const cur = state.sort[state.table];
      const dir = cur.key === key ? (cur.dir === "desc" ? "asc" : "desc") : (TEXT_KEYS.includes(key) && key !== "key" && key !== "last" ? "asc" : "desc");
      set({ sort: { ...state.sort, [state.table]: { key, dir } } });
    },
    project: (el) => set({ drawer: el.dataset.project }),
    "close-drawer": () => set({ drawer: null }),
    locate: (el) => {
      set({ drawer: null, flashWs: el.dataset.ws });
      setTimeout(() => set({ flashWs: null }), 1600);
    },
    "models-toggle": (el) => toggleModels(el),
    collapse: (el) => toggleCard(el.dataset.provider),
    refresh: (el) => runRefresh(el.dataset.refresh),
    layer: (el) => set({ layer: state.layer === el.dataset.layer ? null : el.dataset.layer }),
    "range-day": (el) => pickDay(el.dataset.key),
    "range-preset": (el) => presetRange(el.dataset.days),
    "range-apply": () => set({ period: "custom", range: { ...state.draft }, layer: null, draft: null }),
    "range-cancel": () => set({ layer: null, draft: null }),
    "cal-nav": (el) => set({ calMonth: D.keyOf(D.addMonths(D.fromKey(state.calMonth), Number(el.dataset.dir))) }),
    "limit-mode": (el) => set({ limitMode: el.dataset.mode }),
    "open-settings": () => set({ popover: false, centerTab: "settings", view: "settings", layer: null, drawer: null }),
    copy: (el) => copyText(el.dataset.copy).then(() => {
      el.classList.add("is-done");
      setTimeout(() => el.classList.remove("is-done"), DONE_MS);
    }, () => {}),
    retry: (el) => {
      el.disabled = true;
      el.setAttribute("aria-busy", "true");
      el.textContent = "重试中…";
      setTimeout(() => render(), 1200);
    },
    rescan: () => startRescan(),
    switch: (el) => {
      const path = el.dataset.key.split(".");
      const next = setPath(state, path, !getPath(state, path));
      set(next);
    },
    threshold: (el) => {
      const v = Number(el.dataset.v);
      const list = state.alerts.thresholds;
      const thresholds = list.includes(v) ? list.filter((x) => x !== v) : [...list, v].sort((a, b) => a - b);
      set({ alerts: { ...state.alerts, thresholds } });
    },
  };

  /* ------------------------------------------------------------ 事件 */
  document.addEventListener("click", (e) => {
    const target = e.target;
    const el = target.closest("[data-action]");
    const inApp = target.closest("#app");
    const before = renderCount;
    const patch = {};
    if (inApp && state.popover && !target.closest("#pop") && !target.closest("[data-chip]")) patch.popover = false;
    if (inApp && state.layer && !target.closest(".lay") && !target.closest(`[data-layer-anchor="${state.layer}"]`)) patch.layer = null;
    if (Object.keys(patch).length) silent(patch);
    if (el && !el.disabled && ACTIONS[el.dataset.action]) ACTIONS[el.dataset.action](el);
    if (Object.keys(patch).length && renderCount === before) render();
  });

  document.addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.select) set({ [t.dataset.select]: t.value });
    if (t.dataset.setting) set({ [t.dataset.setting]: t.value });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.layer) set({ layer: null, draft: null });
      else if (state.drawer) set({ drawer: null });
      else if (state.popover) {
        set({ popover: false });
        const chip = $("[data-chip]");
        if (chip) chip.focus();
      }
      return;
    }
    const tag = e.target.tagName;
    if (["INPUT", "SELECT", "TEXTAREA"].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[1-4]$/.test(e.key)) {
      go(VIEW_KEYS[Number(e.key) - 1]);
      return;
    }
    if (e.target.classList && e.target.classList.contains("tcol") && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const cols = [...document.querySelectorAll(".tcol:not(.is-static)")];
      const i = cols.indexOf(e.target);
      const next = cols[i + (e.key === "ArrowLeft" ? -1 : 1)];
      if (next) { next.focus(); showTip(next); }
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && e.target.matches && e.target.matches("tr.is-click")) e.target.click();
  });

  document.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t) showTip(t);
  });
  document.addEventListener("mouseout", (e) => {
    const t = e.target.closest("[data-tip]");
    if (t && !t.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener("focusin", (e) => {
    const t = e.target.closest && e.target.closest("[data-tip]");
    if (t) showTip(t);
    else hideTip();
  });
  window.addEventListener("resize", positionLayers);

  window.addEventListener("error", (e) => {
    const box = $("#err");
    box.hidden = false;
    box.textContent = `设计稿脚本出错：${e.message}`;
  });

  /* ------------------------------------------------------------ 启动 */
  state = { ...INITIAL, ...readHash() };
  render();
  $("#center").addEventListener("scroll", () => { hideTip(); positionLayers(); }, { passive: true });
})();
