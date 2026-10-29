/* ===========================================================================
 * 用量与限额 · 设计稿视图：外壳 / 状态栏芯片 / 弹出面板 / 限额页 / 浮层 / 设置
 * 纯字符串模板；状态全部由 usage-limits.js 传入，这里不持有状态。
 * ======================================================================== */
(function () {
  "use strict";
  const D = window.ULData;
  const F = D.fmt;

  /* -------------------------------------------------------------- 工具 */
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const cls = (...xs) => xs.filter(Boolean).join(" ");
  const pin = (view, n) => `<span class="pin pin--${view}" aria-hidden="true">${n}</span>`;

  const tips = new Map();
  let tipSeq = 0;
  function tip(html) {
    tipSeq += 1;
    tips.set(`t${tipSeq}`, html);
    return `t${tipSeq}`;
  }
  function resetTips() {
    tips.clear();
    tipSeq = 0;
  }

  const P = {
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bellOff: '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="m2 2 20 20"/>',
    chevD: '<path d="m6 9 6 6 6-6"/>',
    chevL: '<path d="m15 18-6-6 6-6"/>',
    chevR: '<path d="m9 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    cal: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5"/><path d="M3 12a9 3 0 0 0 18 0"/>',
    alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    loader: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    arrowR: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    pen: '<path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.4 2.6a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4Z"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    ext: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    term: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  };
  const icon = (name, extra = "") =>
    `<svg class="${cls("ic", extra)}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name]}</svg>`;

  /* 原创像素吉祥物：带天线的小方块。不是 TokenTracker 的 Clawd，也不借用其轮廓与配色。 */
  const SPRITE = ["....#....", "....#....", ".#######.", ".#.###.#.", ".#######.", ".##...##.", ".#######.", "..#...#.."];
  const SPRITE_RECTS = SPRITE.flatMap((row, y) => [...row].map((c, x) => (c === "#"
    ? `<rect x="${x}" y="${y}" width="1" height="1"${y === 0 ? ' class="m-tip"' : ""}/>` : ""))).join("");
  function mascot(px, opts = {}) {
    const lids = '<rect class="m-lid" x="2" y="3" width="1" height="1"/><rect class="m-lid" x="6" y="3" width="1" height="1"/>';
    return `<span class="${cls("mascot", opts.running && "is-running", opts.alert && "is-alert", opts.still && "is-still")}" style="--mh:${px}px" aria-hidden="true"><svg viewBox="0 0 9 8" shape-rendering="crispEdges">${SPRITE_RECTS}${lids}</svg></span>`;
  }

  function refreshBtn(key, label = "刷新", extra = "") {
    return `<button type="button" class="${cls("ibtn", extra)}" data-action="refresh" data-refresh="${key}" aria-label="${label}" title="${label}"><span class="fb" aria-hidden="true">${icon("refresh", "fb__icon")}${icon("check", "fb__check")}</span></button>`;
  }
  function copyBtn(text) {
    return `<button type="button" class="ibtn ibtn--sm" data-action="copy" data-copy="${esc(text)}" aria-label="复制命令" title="复制命令"><span class="fb" aria-hidden="true">${icon("copy", "fb__icon")}${icon("check", "fb__check")}</span></button>`;
  }
  const sw = (key, on, label) =>
    `<button type="button" class="${cls("sw", on && "is-on")}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-action="switch" data-key="${key}"><i></i></button>`;
  const select = (key, value, options, label) =>
    `<select class="sel" data-setting="${key}" aria-label="${esc(label)}">${options.map(([v, l]) => `<option value="${v}"${v === value ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  const engineDot = (id) => `<i class="edot" style="background:${D.ENGINE[id] ? D.ENGINE[id].color : "var(--c-gray)"}"></i>`;

  /* -------------------------------------------------------------- 限额共用 */
  const PROVIDERS = ["claude", "codex"];
  const enabledProviders = (s) => PROVIDERS.filter((id) => s.providers[id]);
  const hasWindows = (L) => ["ok", "rateLimited", "offline"].includes(L.status) && L.windows.length > 0;

  /** 最紧的窗口（已用百分比最高）；到达最低提醒阈值才算「告急」。 */
  function limitAlert(s) {
    let top = null;
    enabledProviders(s).forEach((id) => {
      const L = D.limitsFor(id, s[id], s.tight);
      if (!hasWindows(L)) return;
      L.windows.forEach((w) => {
        if (!top || w.used > top.used) top = { ...w, provider: L.name };
      });
    });
    if (!top) return null;
    const threshold = Math.min(...s.alerts.thresholds, 101);
    const level = top.used >= 95 ? "danger" : top.used >= threshold ? "warn" : null;
    return {
      top, level, pct: top.used, short: top.short,
      title: `${top.provider} ${top.label} 已用 ${top.used}%，${F.durZh(top.resetInSec)}后重置`,
    };
  }

  function paceText(p, s) {
    const remaining = s.limitMode === "remaining";
    if (p.kind === "idle") return "本窗口尚未使用";
    if (p.kind === "early") return "窗口刚开始，暂不预测";
    if (p.kind === "ok") {
      const v = Math.round(p.projected * 100);
      return remaining ? `节奏正常 · 预计重置时还剩 ${100 - v}%` : `节奏正常 · 预计重置时用到 ${v}%`;
    }
    return `偏快 · 按当前速度约 ${F.durZh(p.runOutSec)}后用完，比重置早 ${F.durZh(p.earlySec)}`;
  }

  function limitRow(s, w, opts = {}) {
    const p = D.pace(w);
    const remaining = s.limitMode === "remaining";
    const shown = remaining ? 100 - w.used : w.used;
    const level = w.used >= 90 ? "danger" : w.used >= 70 ? "warn" : "ok";
    const tickPos = p.marker == null ? null : (remaining ? 1 - p.marker : p.marker) * 100;
    const tickTip = tickPos == null ? "" : tip(`<b>时间进度 ${Math.round(p.marker * 100)}%</b><br>按均匀消耗，此刻应${remaining ? "还剩" : "用到"} ${Math.round(tickPos)}%。<br>${p.kind === "over" ? "实际已超过刻度：节奏偏快。" : "实际在刻度以内：节奏正常。"}`);
    const tick = tickPos == null ? "" : `<i class="${cls("bar__tick", p.kind === "over" && "is-over")}" style="left:${tickPos}%" data-tip="${tickTip}"></i>`;
    const bar = `<span class="bar is-${level}" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${shown}" aria-label="${esc(w.label)}${remaining ? "剩余" : "已用"} ${shown}%"><i class="bar__fill" style="width:${shown}%"></i>${tick}</span>`;
    const resetAbs = `${F.resetAt(w.resetInSec)} 重置`;
    if (opts.compact) {
      return `<div class="${cls("lrow lrow--c", opts.stale && "is-stale")}"><span class="lrow__lbl">${esc(w.short)}</span>${bar}<span class="lrow__pct is-${level}">${shown}%</span><span class="lrow__reset" title="${esc(resetAbs)}">${F.dur(w.resetInSec)}</span></div>`;
    }
    return `<div class="${cls("lrow", opts.stale && "is-stale")}">
      <span class="lrow__lbl">${esc(w.label)}${w.scoped ? '<span class="tag">模型</span>' : ""}</span>
      ${bar}
      <span class="lrow__pct is-${level}">${shown}%<small>${remaining ? "剩余" : "已用"}</small></span>
      <span class="lrow__reset" title="${esc(resetAbs)}">${F.durZh(w.resetInSec)}后重置</span>
      <p class="lrow__pace is-${p.kind}">${paceText(p, s)}</p>
    </div>`;
  }

  function extraRow(extra, stale) {
    const pct = (extra.used / extra.limit) * 100;
    return `<div class="${cls("lrow lrow--extra", stale && "is-stale")}">
      <span class="lrow__lbl">额外用量</span>
      <span class="bar is-ok"><i class="bar__fill" style="width:${pct}%"></i></span>
      <span class="lrow__pct">${F.usd(extra.used)}<small>/ ${F.usd(extra.limit)}</small></span>
      <span class="lrow__reset">本月</span>
      <p class="lrow__pace">订阅额度用完后按量计费的部分（Extra usage）；账号未开启时不显示这一行。</p>
    </div>`;
  }

  const modeSeg = (s, small) => `<div class="${cls("seg", small ? "seg--xs" : "seg--sm")}" role="radiogroup" aria-label="限额显示方式">
      <button type="button" role="radio" aria-checked="${s.limitMode === "used"}" data-action="limit-mode" data-mode="used">已用</button>
      <button type="button" role="radio" aria-checked="${s.limitMode === "remaining"}" data-action="limit-mode" data-mode="remaining">剩余</button>
    </div>`;

  const plogo = (id) => `<span class="plogo plogo--${id}" aria-hidden="true">${id === "claude" ? "✳" : "◎"}</span>`;

  /* -------------------------------------------------------------- 外壳 */
  function sidebar(s) {
    const alert = limitAlert(s);
    const badge = alert && alert.level ? `<span class="side__badge is-${alert.level}" title="${esc(alert.title)}">${alert.pct}%</span>` : "";
    const dot = (run) => `<i class="${run ? "dot-run" : "dot-idle"}"></i>`;
    return `
      <div class="side__top">
        <span class="side__btn">${icon("pen")}<span>新对话</span></span>
        <span class="side__btn">${icon("search")}<span>搜索</span></span>
      </div>
      <nav class="side__nav" aria-label="导航">
        <span class="side__item">${icon("zap")}<span>自动化</span></span>
        <button type="button" class="${cls("side__item", s.centerTab === "usage" && "is-active")}" data-action="open-usage" data-page="${s.page}">
          ${icon("gauge")}<span>用量</span>${badge}${pin("dashboard", 1)}
        </button>
      </nav>
      <p class="side__label">工作区</p>
      <div class="side__ws">
        <div class="${cls("side__wsrow", s.flashWs === "ccgui" && "is-flash")}">${icon("folder")}<span>desktop-cc-gui</span></div>
        <div class="side__sess is-active">${dot(s.running)}<span>修复状态栏缩放错位</span></div>
        <div class="side__sess">${dot(false)}<span>插件市场精选区</span></div>
        <div class="${cls("side__wsrow", s.flashWs === "jb" && "is-flash")}">${icon("folder")}<span>jetbrains-cc-gui</span></div>
        <div class="side__sess">${dot(false)}<span>Gateway 断线重连</span></div>
        <div class="${cls("side__wsrow", s.flashWs === "plugins" && "is-flash")}">${icon("folder")}<span>ccgui-plugins</span></div>
        <div class="${cls("side__wsrow", s.flashWs === "vs" && "is-flash")}">${icon("folder")}<span>vscode-cc-gui</span></div>
      </div>`;
  }

  function tabs(s) {
    if (s.centerTab === "settings") return `<div class="ctab is-active">${icon("sliders")}<span>设置</span></div>`;
    const chat = `<button type="button" class="${cls("ctab", s.centerTab === "chat" && "is-active")}" data-action="tab" data-tab="chat">${icon("msg")}<span>修复状态栏缩放错位</span>${s.running ? '<i class="dot-run"></i>' : ""}</button>`;
    const usage = s.usageTabOpen
      ? `<div class="${cls("ctab", s.centerTab === "usage" && "is-active")}"><button type="button" class="ctab__main" data-action="tab" data-tab="usage">${icon("gauge")}<span>用量</span></button><button type="button" class="ctab__x" data-action="close-usage" aria-label="关闭用量页签" title="关闭">${icon("x")}</button></div>`
      : "";
    return chat + usage;
  }

  function chat(s) {
    return `<div class="chat">
      <div class="chat__msgs">
        <div class="bubble">状态栏缩放按钮在 125% 时和版本号挤在一起，帮我看一下。</div>
        <div class="answer"><i style="width:82%"></i><i style="width:64%"></i><i style="width:71%"></i><i style="width:38%"></i></div>
        ${s.running ? '<p class="chat__running"><i class="dot-run"></i>正在运行 · 读取 app-status-bar.tsx</p>' : ""}
      </div>
      <div class="composer">
        <div class="composer__box">描述任务，@ 引用文件…</div>
        <div class="composer__row"><span>main</span><span>·</span><span>上下文 38%</span></div>
      </div>
    </div>`;
  }

  function statusbar(s) {
    return `<div class="status__start">${pin("statusbar", 1)}${chip(s)}</div>
      <div class="status__end">
        <span class="sb-item">${icon("activity")}性能</span><span class="sb-sep">·</span>
        <span class="sb-zoom"><span class="sb-ib">${icon("minus")}</span><span>100%</span><span class="sb-ib">${icon("plus")}</span></span><span class="sb-sep">·</span>
        <span class="sb-ib">${icon("refresh")}</span><span class="sb-sep">·</span><span>已同步</span><span class="sb-sep">·</span><span>v1.1.9</span>
      </div>`;
  }

  const CHIP_PERIOD = { today: "今日", "7d": "7 天", month: "本月" };
  function chipRange(period) {
    if (period === "7d") return [D.addDays(D.TODAY, -6), D.TODAY];
    if (period === "month") return [D.startOfMonth(D.TODAY), D.TODAY];
    return [D.TODAY, D.TODAY];
  }

  function chip(s) {
    const attrs = `type="button" class="${cls("chip", s.popover && "is-open")}" data-chip data-action="toggle-popover" aria-haspopup="dialog" aria-expanded="${s.popover}"`;
    if (s.scanning) return `<button ${attrs} title="正在首次统计本机用量">${icon("loader", "spin")}<span>统计用量… 37%</span></button>`;
    const alert = limitAlert(s);
    const glyph = s.mascot
      ? mascot(16, { running: s.running && s.mascotMotion, alert: !!(alert && alert.level), still: !s.mascotMotion })
      : icon("gauge");
    if (s.empty) return `<button ${attrs} title="还没有用量记录 · 点击查看">${glyph}<span class="chip__muted">暂无用量</span>${pin("statusbar", 2)}</button>`;
    const [from, to] = chipRange(s.chipPeriod);
    const sum = D.sumRange(from, to);
    const label = CHIP_PERIOD[s.chipPeriod];
    let body;
    if (s.chipMode === "limit") {
      body = alert
        ? `<span class="chip__lbl">${esc(alert.top.provider)} ${esc(alert.short)}</span><b>${alert.pct}%</b><span class="chip__muted">${F.dur(alert.top.resetInSec)}</span>`
        : '<span class="chip__muted">无限额数据</span>';
    } else {
      const parts = [];
      if (s.chipMode !== "cost") parts.push(`<b>${F.tokens(sum.total)}</b><span class="chip__unit">tokens</span>`);
      if (s.chipMode !== "tokens") parts.push(`<b>${F.usd(sum.cost)}</b>`);
      body = `<span class="chip__lbl">${label}</span>${parts.join('<span class="chip__sep">·</span>')}`;
    }
    const tag = alert && alert.level && s.chipAlert && s.chipMode !== "limit"
      ? `<span class="chip__alert is-${alert.level}">${esc(alert.short)} ${alert.pct}%</span>${pin("statusbar", 4)}` : "";
    const title = `${label} ${F.tokens(sum.total)} tokens · 估算 ${F.usd(sum.cost)} · ${F.ago(s.ago.usage)}更新${alert && alert.level ? `\n${alert.title}` : ""}\n点击查看用量与限额`;
    return `<button ${attrs} title="${esc(title)}">${glyph}${pin("statusbar", 5)}${body}${pin("statusbar", 2)}${tag}</button>`;
  }

  /* -------------------------------------------------------------- 弹出面板 */
  function bubbleText(s) {
    if (s.scanning) return "正在数 token，第一次会久一点…";
    if (s.empty) return "还没有用量，开始一段对话吧";
    const alert = limitAlert(s);
    if (alert && alert.level) return `${alert.top.provider} ${alert.top.label}窗口用得有点快`;
    const d = D.todayVsYesterday();
    if (d == null) return "今天开工了";
    const pct = Math.round(Math.abs(d) * 100);
    return pct < 3 ? "和昨天这个时候差不多" : `比昨天这个时候${d > 0 ? "多" : "少"}用了 ${pct}%`;
  }

  function popover(s) {
    if (!s.popover) return "";
    const body = s.scanning ? popScanning() : s.empty ? popEmpty() : popStats(s);
    return `<div class="pop" id="pop" role="dialog" aria-label="用量概览">
      <header class="pop__head">
        ${mascot(30, { running: s.running && s.mascotMotion, alert: !!(limitAlert(s) || {}).level, still: !s.mascotMotion })}
        <div class="pop__say"><span class="say">${esc(bubbleText(s))}</span><span class="pop__ago">更新于 ${F.ago(s.ago.usage)}</span></div>
        ${refreshBtn("pop")}${pin("statusbar", 7)}
        <button type="button" class="ibtn" data-action="open-settings" aria-label="用量与限额设置" title="用量与限额设置">${icon("sliders")}</button>
      </header>
      ${body}
      ${popLimits(s)}
      <footer class="pop__foot">
        <button type="button" class="lnk" data-action="open-usage" data-page="overview">用量概览${icon("arrowR")}</button>
        <button type="button" class="lnk" data-action="open-usage" data-page="limits">限额详情${icon("arrowR")}</button>${pin("statusbar", 12)}
      </footer>
    </div>`;
  }

  const popScanning = () => `<div class="pop__state">${icon("loader", "spin")}<div><b>正在首次统计本机用量 · 37%</b><p>已读取 1,284 / 3,460 个会话文件。之后只增量读取新内容。</p></div></div>`;
  const popEmpty = () => `<div class="pop__state"><div><b>还没有用量记录</b><p>在 CC GUI 或任一受支持的 CLI 里完成一次对话后，这里会自动出现统计。</p></div></div>`;

  function popStats(s) {
    const today = D.sumRange(D.TODAY, D.TODAY);
    const delta = D.todayVsYesterday();
    const hours = D.hourFractions(D.keyOf(D.TODAY));
    const hmax = Math.max(...hours);
    const w7 = D.sumRange(D.addDays(D.TODAY, -6), D.TODAY);
    const d30 = D.sumRange(D.addDays(D.TODAY, -29), D.TODAY);
    const all = D.sumRange(D.FIRST_DAY, D.TODAY);
    const split = (x) => `输入 ${F.tokens(x.input)} · 输出 ${F.tokens(x.output)} · 缓存读 ${F.tokens(x.cacheRead)} · 缓存写 ${F.tokens(x.cacheWrite)}`;
    const deltaHtml = delta == null ? "" : `<span class="delta ${delta >= 0 ? "is-up" : "is-down"}">${delta >= 0 ? "↑" : "↓"} ${Math.abs(Math.round(delta * 100))}% 较昨日同时</span>`;
    const card = (label, sum, sub, period, n) => `<button type="button" class="pcard-s" data-action="goto-period" data-period="${period}" title="${esc(split(sum))}">
        <span class="pcard-s__lbl">${label}${n ? pin("statusbar", n) : ""}</span><b>${F.tokens(sum.total)}</b><span class="pcard-s__cost">${F.usd(sum.cost)}</span><span class="pcard-s__sub">${sub}</span></button>`;
    return `<button type="button" class="ptoday" data-action="goto-period" data-period="day" title="${esc(split(today))}">
        <span class="ptoday__l"><span class="ptoday__lbl">今日${pin("statusbar", 8)}</span><b class="ptoday__num">${F.tokens(today.total)}</b><span class="ptoday__meta"><span>${F.usd(today.cost)}</span>${deltaHtml}</span></span>
        <span class="spark" aria-hidden="true">${hours.map((h, i) => `<i class="${i > D.NOW.getHours() ? "is-future" : ""}" style="height:${Math.max(4, (h / hmax) * 100)}%"></i>`).join("")}</span>
      </button>
      <div class="pcards">
        ${card("近 7 天", w7, `${D.activeDays(D.addDays(D.TODAY, -6), D.TODAY)} 个活跃日`, "7d", 9)}
        ${card("近 30 天", d30, `日均 ${F.tokens(d30.total / 30)}`, "30d")}
        ${card("总计", all, `自 ${F.dateZh(D.FIRST_DAY)}`, "all")}
      </div>`;
  }

  function popLimits(s) {
    const ids = enabledProviders(s);
    if (!ids.length) return "";
    return `<section class="plim" aria-label="限额">
      <header class="plim__head"><span>限额${pin("statusbar", 10)}</span>${modeSeg(s, true)}</header>
      ${ids.map((id) => popProvider(s, id)).join("")}
    </section>`;
  }

  function popProvider(s, id) {
    const L = D.limitsFor(id, s[id], s.tight);
    const L2 = { ...L, agoSec: L.agoSec == null ? null : (s.ago[id] ?? L.agoSec) };
    const head = `<div class="pprov__head">${plogo(id)}<b>${L.name}</b>${L.plan ? `<span class="plan">${L.plan}</span>` : ""}${L2.status !== "ok" && L2.agoSec != null ? `<span class="pprov__ago">${F.ago(L2.agoSec)}的数据</span>` : ""}</div>`;
    const line = (text, err) => `<p class="${cls("pprov__state", err && "is-error")}">${text}${pin("statusbar", 11)}</p>`;
    let body;
    if (L.status === "loading") body = '<div class="skel skel--row"></div><div class="skel skel--row"></div>';
    else if (L.status === "signedOut") body = line(`未登录 · 在终端运行 <code>${L.cmd}</code> 登录`);
    else if (L.status === "expired") body = line(`登录已过期 · 在终端运行一次 <code>${L.cmd}</code> 续期`);
    else {
      const rows = L.windows.map((w) => limitRow(s, w, { compact: true, stale: L.status !== "ok" })).join("");
      const note = L.status === "rateLimited" ? line("接口限流 · 稍后自动重试")
        : L.status === "offline" ? line(`无法连接 ${L.host}`, true) : "";
      body = rows + note;
    }
    return `<div class="pprov">${head}${body}</div>`;
  }

  /* -------------------------------------------------------------- 用量页签 */
  function pageHead(s) {
    const isLimits = s.page === "limits";
    const alert = limitAlert(s);
    const actions = isLimits
      ? `${modeSeg(s)}${pin("limits", 2)}${refreshBtn("limits")}${pin("limits", 10)}
         <button type="button" class="${cls("ibtn", s.layer === "bell" && "is-on")}" data-action="layer" data-layer="bell" data-layer-anchor="bell" aria-label="提醒设置" title="提醒设置" aria-expanded="${s.layer === "bell"}">${icon(s.alerts.on ? "bell" : "bellOff")}</button>${pin("limits", 11)}
         <button type="button" class="ibtn" data-action="open-settings" aria-label="用量与限额设置" title="用量与限额设置">${icon("sliders")}</button>`
      : `<button type="button" class="${cls("btn btn--sm", s.layer === "sources" && "is-on")}" data-action="layer" data-layer="sources" data-layer-anchor="sources" aria-expanded="${s.layer === "sources"}">${icon("db")}数据来源</button>${pin("dashboard", 12)}${refreshBtn("overview")}`;
    return `<header class="phead">
      <div class="phead__l">
        <h2>用量</h2>
        <nav class="itabs" role="tablist" aria-label="用量分页">
          <button type="button" role="tab" aria-selected="${!isLimits}" data-action="page" data-page="overview">概览</button>
          <button type="button" role="tab" aria-selected="${isLimits}" data-action="page" data-page="limits">限额${alert && alert.level ? `<span class="itabs__badge is-${alert.level}">${alert.pct}%</span>` : ""}</button>
        </nav>
      </div>
      <div class="phead__r">${actions}</div>
    </header>`;
  }

  function usagePage(s) {
    const body = s.page === "limits" ? limitsBody(s) : window.ULOverview.overview(s);
    return `<div class="page">${pageHead(s)}${body}</div>`;
  }

  /* -------------------------------------------------------------- 限额页 */
  function limitsBody(s) {
    const ids = enabledProviders(s);
    const hidden = PROVIDERS.filter((id) => !s.providers[id]).map((id) => D.limitsFor(id, "ok").name);
    return `<div class="lim">
      <p class="lim__intro">${pin("limits", 1)}订阅账号的速率限制窗口。只读取本机 CLI 已有的登录状态去查询官方接口，不刷新、不改写你的登录凭据。</p>
      ${ids.map((id) => provCard(s, id)).join("")}
      ${hidden.length ? `<p class="lim__hidden">已在设置中隐藏：${hidden.join("、")} · <button type="button" class="lnk" data-action="open-settings">去设置</button></p>` : ""}
      ${ids.length ? "" : '<div class="empty"><h3>没有启用的平台</h3><p>在设置里打开 Claude 或 Codex 后，这里会显示它们的限额。</p></div>'}
    </div>`;
  }

  function provCard(s, id) {
    const L = D.limitsFor(id, s[id], s.tight);
    const ago = L.agoSec == null ? null : (s.ago[id] ?? L.agoSec);
    const collapsed = !!s.collapsed[id];
    const meta = L.status === "loading" ? "读取中…" : ago != null ? `更新于 ${F.ago(ago)}` : "";
    return `<section class="${cls("pcard", collapsed && "is-collapsed")}" data-card="${id}">
      <button type="button" class="pcard__head" data-action="collapse" data-provider="${id}" aria-expanded="${!collapsed}">
        ${plogo(id)}<b>${L.name}</b>${L.plan ? `<span class="plan">${L.plan}</span>` : ""}
        <span class="pcard__meta">${meta}</span>${icon("chevD", "pcard__chev")}${pin("limits", 12)}
      </button>
      <div class="pcard__body" ${collapsed ? 'aria-hidden="true" inert' : ""}><div class="pcard__inner">${provBody(s, id, L, ago)}</div></div>
    </section>`;
  }

  function provBody(s, id, L, ago) {
    if (L.status === "loading") return '<div class="pcard__rows"><div class="skel skel--lrow"></div><div class="skel skel--lrow"></div></div>';
    if (L.status === "signedOut" || L.status === "expired") {
      const title = L.status === "signedOut" ? `未检测到 ${id === "claude" ? "Claude Code" : "Codex"} 登录` : `${id === "claude" ? "Claude Code" : "Codex"} 登录已过期`;
      const desc = L.status === "signedOut"
        ? "在终端运行下面的命令并完成登录，然后点右上角刷新。"
        : "插件不会替你刷新登录。在终端运行一次下面的命令，让 CLI 自己续期后再刷新。";
      return `<div class="lstate">${pin("limits", 7)}<p class="lstate__title">${title}</p><p class="lstate__desc">${desc}</p>
        <div class="cmd">${icon("term")}<code>${L.cmd}</code>${copyBtn(L.cmd)}</div></div>`;
    }
    const banner = L.status === "rateLimited"
      ? `<div class="banner is-warn">${icon("alert")}<span>接口限流（429），显示 ${F.ago(ago)}的数据 · ${F.durZh(L.retryInSec)}后自动重试</span>${pin("limits", 8)}</div>`
      : L.status === "offline"
        ? `<div class="banner is-error" role="alert">${icon("alert")}<span>无法连接 ${L.host}（网络错误）。下面是 ${F.ago(ago)}的数据。</span><button type="button" class="btn btn--xs" data-action="retry" data-provider="${id}">重试</button>${pin("limits", 9)}</div>`
        : "";
    const stale = L.status !== "ok";
    const rows = L.windows.map((w, i) => limitRow(s, w, { stale }) + (i === 0 ? pin("limits", 3) : "")).join("");
    const extra = id === "claude" && L.extra ? extraRow(L.extra, stale) + pin("limits", 5) : "";
    const weekly = id === "codex" && L.windows.length === 1 ? `<p class="pcard__note">当前套餐（${L.plan}）只有每周窗口。${pin("limits", 6)}</p>` : "";
    return `${banner}<div class="pcard__rows">${rows}${pin("limits", 4)}${extra}</div>${weekly}`;
  }

  /* -------------------------------------------------------------- 浮层 */
  function sourcesLayer(s) {
    const status = (src) => {
      if (src.status === "missing") return '<span class="src__st is-muted">未找到目录</span>';
      if (src.status === "denied") return '<span class="src__st is-error">无读取权限</span>';
      return `<span class="src__st">${F.int(src.files)} 个文件 · ${F.ago(s.ago.scan)}</span>`;
    };
    const foot = s.rescan != null
      ? `<div class="progress-line">${icon("loader", "spin")}<span>正在重新扫描… ${s.rescan}%</span><span class="progress"><i style="width:${s.rescan}%"></i></span></div>`
      : '<button type="button" class="btn btn--sm" data-action="rescan">重新扫描全部</button><span class="lay__hint">重建本地索引，不改动各 CLI 的原始日志</span>';
    return `<div class="lay lay--sources" data-layer-for="sources" role="dialog" aria-label="数据来源">
      <header class="lay__head"><b>数据来源</b><span>每个 CLI 的会话日志目录。对话结束后自动增量更新；CC GUI 之外运行的 CLI 由文件监听补齐。</span></header>
      <ul class="src">${D.SOURCES.map((src) => `<li class="${cls(!s.sources[src.id] && "is-off")}"><i class="src__dot is-${src.status}"></i><div class="src__t"><b>${src.name}</b><code>${src.dir}</code>${src.env ? `<small>可由 ${src.env} 覆盖</small>` : ""}</div>${s.sources[src.id] ? status(src) : '<span class="src__st is-muted">已排除</span>'}</li>`).join("")}</ul>
      <footer class="lay__foot">${foot}</footer>
    </div>`;
  }

  function bellLayer(s) {
    const chips = [70, 80, 90, 95].map((v) => `<button type="button" class="${cls("tchip", s.alerts.thresholds.includes(v) && "is-on")}" data-action="threshold" data-v="${v}" aria-pressed="${s.alerts.thresholds.includes(v)}" ${s.alerts.on ? "" : "disabled"}>${v}%</button>`).join("");
    return `<div class="lay lay--bell" data-layer-for="bell" role="dialog" aria-label="提醒设置">
      <header class="lay__head lay__head--row"><b>接近上限时提醒</b>${sw("alerts.on", s.alerts.on, "接近上限时提醒")}</header>
      <p class="lay__p">任一窗口达到下列阈值时发一次系统通知。同一窗口在一个重置周期内，每个阈值只提醒一次。</p>
      <div class="tchips" role="group" aria-label="提醒阈值">${chips}</div>
      <div class="lay__row"><span>状态栏标记告急窗口</span>${sw("chipAlert", s.chipAlert, "状态栏标记告急窗口")}</div>
      <div class="lay__row"><span>关闭面板后仍在后台查询（15 分钟）</span>${sw("alerts.background", s.alerts.background, "后台查询")}</div>
    </div>`;
  }

  function layer(s) {
    const parts = [popover(s)];
    if (s.centerTab === "usage" && s.layer === "sources" && s.page === "overview") parts.push(sourcesLayer(s));
    if (s.centerTab === "usage" && s.layer === "bell" && s.page === "limits") parts.push(bellLayer(s));
    if (s.centerTab === "usage" && s.page === "overview") parts.push(window.ULOverview.overlays(s));
    return parts.join("");
  }

  /* -------------------------------------------------------------- 设置 */
  const srow = (label, desc, control, pinHtml = "") =>
    `<div class="srow"><div class="srow__t"><b>${label}${pinHtml}</b>${desc ? `<p>${desc}</p>` : ""}</div><div class="srow__c">${control}</div></div>`;
  const scard = (title, rows, pinHtml = "") => `<section class="scard"><h3>${title}${pinHtml}</h3>${rows.join("")}</section>`;

  function settings(s) {
    const thresholds = [70, 80, 90, 95].map((v) => `<button type="button" class="${cls("tchip", s.alerts.thresholds.includes(v) && "is-on")}" data-action="threshold" data-v="${v}" aria-pressed="${s.alerts.thresholds.includes(v)}" ${s.alerts.on ? "" : "disabled"}>${v}%</button>`).join("");
    const srcRows = D.SOURCES.map((src) => {
      const st = src.status === "missing" ? '<span class="is-muted">未找到</span>'
        : src.status === "denied" ? '<span class="is-error">无读取权限</span>' : `${F.int(src.files)} 个文件`;
      return `<div class="srcrow ${s.sources[src.id] ? "" : "is-off"}"><i class="src__dot is-${src.status}"></i><b>${src.name}</b><code>${src.dir}</code><span class="srcrow__st">${st}</span>${sw(`sources.${src.id}`, s.sources[src.id], `统计 ${src.name}`)}</div>`;
    }).join("");
    const rescan = s.rescan != null
      ? `<div class="progress-line">${icon("loader", "spin")}<span>正在重新扫描… ${s.rescan}%</span><span class="progress"><i style="width:${s.rescan}%"></i></span></div>`
      : '<button type="button" class="btn btn--sm" data-action="rescan">重新扫描全部</button>';
    const navItems = ["通用", "CLI 管理", "供应商", "MCP", "Skills", "提示词", "网络与代理", "其他"];
    return `<div class="set">
      <nav class="set__nav" aria-label="设置分区">
        <p class="set__grp">应用</p>
        ${navItems.map((x) => `<span class="set__item">${x}</span>`).join("")}
        <span class="set__item is-removed" title="宿主原「用量」设置页已删除">用量<em>已移除</em>${pin("settings", 1)}</span>
        <p class="set__grp">插件</p>
        <span class="set__item">Git 任务管理</span>
        <span class="set__item is-active">用量与限额${pin("settings", 2)}</span>
      </nav>
      <div class="set__body">
        <header class="set__head"><h2>用量与限额</h2><p>插件 · v0.1.0 · 数字由 CC GUI 在本机计算，插件只负责显示</p></header>
        ${scard("状态栏", [
          srow("显示内容", "", select("chipMode", s.chipMode, [["both", "Tokens + 费用"], ["tokens", "仅 Tokens"], ["cost", "仅费用"], ["limit", "最紧的限额窗口"]], "显示内容")),
          srow("统计范围", "", select("chipPeriod", s.chipPeriod, [["today", "今日"], ["7d", "近 7 天"], ["month", "本月"]], "统计范围")),
          srow("像素吉祥物", "关闭后显示线性图标。", sw("mascot", s.mascot, "像素吉祥物")),
          srow("运行时动画", "有会话运行时轻跳、空闲时偶尔眨眼；系统开启「减少动态效果」时始终静止。", sw("mascotMotion", s.mascotMotion, "运行时动画")),
          srow("限额告急标记", "任一窗口达到提醒阈值时，在数字后面追加窗口与百分比。", sw("chipAlert", s.chipAlert, "限额告急标记")),
        ], pin("settings", 3))}
        ${scard("限额", [
          srow("显示方式", "面板与限额页同步。", modeSeg(s)),
          srow("自动刷新", "只在面板或限额页可见时刷新。", select("autoRefresh", s.autoRefresh, [["5", "每 5 分钟"], ["10", "每 10 分钟"], ["15", "每 15 分钟"], ["30", "每 30 分钟"], ["off", "关闭"]], "自动刷新")),
          srow("Claude", "读取 Claude Code 的本机登录（macOS 钥匙串 / ~/.claude/.credentials.json），只请求 api.anthropic.com。", sw("providers.claude", s.providers.claude, "Claude 限额")),
          srow("Codex", "读取 ~/.codex/auth.json，只请求 chatgpt.com。", sw("providers.codex", s.providers.codex, "Codex 限额")),
          srow("接近上限时提醒", "系统通知；每个窗口每个重置周期每档只提醒一次。", `<div class="srow__stack">${sw("alerts.on", s.alerts.on, "接近上限时提醒")}<div class="tchips">${thresholds}</div></div>`),
        ])}
        ${scard("数据来源", [
          `<div class="srclist">${srcRows}</div>`,
          srow("重新扫描", "重建本地索引；不改动各 CLI 的原始日志。目录会跟随 CLAUDE_CONFIG_DIR、CODEX_HOME 等环境变量。", rescan),
        ])}
        ${scard("价格", [
          srow("价格表", "内置快照 · 2026-10-20 · 2,140 个模型", '<span class="is-muted">已是最新</span>'),
          srow("自动更新价格表", "每 24 小时从 GitHub 下载 LiteLLM 的公开价格表，只下载、不上传；失败时沿用上一次。", sw("priceAuto", s.priceAuto, "自动更新价格表"), pin("settings", 4)),
          srow("没有价格的模型", "这些模型的用量不计入费用，也不会拿别的模型价格去猜。", '<code class="mono">deepseek-v4-pro</code>'),
        ])}
        ${scard("隐私与来源", [
          '<p class="sp">用量统计完全在本机完成，不上传任何数据（自动更新价格表只下载公开文件）。</p>',
          '<p class="sp">查询限额时使用本机 CLI 已有的登录凭据，只发往对应厂商的官方接口。凭据只在 CC GUI 主进程里使用，插件拿不到。</p>',
          `<p class="sp">交互与信息架构参考了 <span class="lnk">TokenTracker${icon("ext")}</span>（MIT © 2026 xiufengsun）；视觉、文案、吉祥物与代码为本插件原创实现。完整声明见 <span class="lnk">第三方声明</span>。</p>`,
        ], pin("settings", 5))}
      </div>
    </div>`;
  }

  function center(s) {
    if (s.centerTab === "settings") return settings(s);
    if (s.centerTab === "usage") return usagePage(s);
    return chat(s);
  }

  window.ULKit = { esc, cls, pin, tip, icon, mascot, refreshBtn, engineDot, sw };
  window.ULViews = { sidebar, tabs, center, statusbar, layer, tips, resetTips, limitAlert };
})();
