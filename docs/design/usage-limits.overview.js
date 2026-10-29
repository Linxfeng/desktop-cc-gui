/* ===========================================================================
 * 用量与限额 · 设计稿视图：用量概览页（周期 / 总量 / 趋势 / 明细 / 热力图 /
 * 模型排行）以及它的浮层（日期区间、项目抽屉）。
 * ======================================================================== */
(function () {
  "use strict";
  const D = window.ULData;
  const F = D.fmt;
  const { esc, cls, pin, tip, icon, mascot, engineDot } = window.ULKit;

  const PERIODS = [["day", "日"], ["week", "周"], ["month", "月"], ["year", "年"], ["all", "全部"], ["custom", "自定义"]];
  const p = (n) => pin("dashboard", n);
  const endOf = (pr) => D.minDate(pr.to, D.TODAY);

  function overview(s) {
    if (s.scanning) return scanning();
    if (s.empty) return empty();
    const pr = D.periodRange(s.period, s.anchor, s.range);
    const sum = D.sumRange(pr.from, pr.to, s.engine);
    return `<div class="ov">
      ${periodBar(s, pr)}
      ${hero(s, pr, sum)}
      <div class="ov__grid">
        <div class="ov__main">${trend(s, pr)}${table(s, pr)}</div>
        <div class="ov__side">${stats(s, pr, sum)}${models(s, pr)}${heatmap(s, pr)}</div>
      </div>
      <p class="ov__foot">示例数据 · 价格为示例值，不是任何厂商的真实报价</p>
    </div>`;
  }

  /* ------------------------------------------------------------ 周期条 */
  function periodBar(s, pr) {
    const unit = D.UNIT[s.period];
    let nav = "";
    if (s.period === "custom") {
      nav = `<span class="pnav__lbl">${pr.label}</span><span class="pnav__muted">${D.daysBetween(pr.from, pr.to) + 1} 天</span>`;
    } else if (s.period === "all") {
      nav = `<span class="pnav__lbl">${pr.label}</span>`;
    } else {
      nav = `<button type="button" class="ibtn ibtn--sm" data-action="nav" data-dir="-1" aria-label="上一${unit}" title="上一${unit}" ${D.canShift(s.period, s.anchor, s.range, -1) ? "" : "disabled"}>${icon("chevL")}</button>
        <span class="pnav__lbl">${pr.label}</span>
        <button type="button" class="ibtn ibtn--sm" data-action="nav" data-dir="1" aria-label="下一${unit}" title="下一${unit}" ${D.canShift(s.period, s.anchor, s.range, 1) ? "" : "disabled"}>${icon("chevR")}</button>
        ${pr.containsToday ? "" : `<button type="button" class="btn btn--xs" data-action="nav-today">回到${D.THIS_UNIT[s.period]}</button>`}`;
    }
    const filter = s.engine
      ? `<span class="fchip">${engineDot(s.engine)}只看 ${esc(D.ENGINE[s.engine].name)}<button type="button" data-action="engine" data-engine="${s.engine}" aria-label="取消筛选" title="取消筛选">${icon("x")}</button></span>`
      : "";
    const tabsHtml = PERIODS.map(([id, label]) => {
      const anchorAttr = id === "custom" ? ' data-layer-anchor="range"' : "";
      return `<button type="button" role="tab" aria-selected="${s.period === id}" data-action="period" data-period="${id}"${anchorAttr}>${id === "custom" ? icon("cal") : ""}${label}</button>`;
    }).join("");
    return `<div class="pbar">
      <div class="seg seg--sm" role="tablist" aria-label="统计周期">${tabsHtml}</div>${p(2)}${p(3)}
      <div class="pnav">${nav}</div>
      ${filter}
    </div>`;
  }

  /* -------------------------------------------------------------- 总量 */
  function hero(s, pr, sum) {
    const cmp = D.compare(pr, s.engine);
    const span = D.daysBetween(pr.from, endOf(pr)) + 1;
    const active = D.activeDays(pr.from, pr.to, s.engine);
    const forecast = D.forecastTotal(pr, s.engine);
    const shares = D.engineShares(pr.from, pr.to);
    const allModels = new Set(D.rowsBetween(pr.from, endOf(pr)).map((r) => r.model)).size;
    const costTip = tip("<b>估算费用</b><br>按价格表计算：输入 + 输出 + 缓存读 + 缓存写。<br>订阅套餐（Claude Max、ChatGPT Pro 等）实际不按此计费，只作量级参考。");
    const cmpHtml = cmp ? `<p class="delta ${cmp.delta >= 0 ? "is-up" : "is-down"}">${cmp.delta >= 0 ? "↑" : "↓"} ${Math.abs(Math.round(cmp.delta * 100))}%<span>${cmp.label}</span></p>` : "";
    const warn = sum.unknownModels.length
      ? `<p class="hero__warn">${icon("alert")}<span>${sum.unknownModels.length} 个模型没有价格（${sum.unknownModels.map(esc).join("、")}），这部分 ${F.tokens(sum.unknownTokens)} tokens 未计入费用。</span><button type="button" class="lnk" data-action="table" data-table="model">查看</button>${p(5)}</p>`
      : "";
    const bar = shares.map((x) => {
      const t = tip(`<b>${esc(D.ENGINE[x.id].name)}</b><br>${F.tokens(x.total)} tokens · ${F.share(x.share)}`);
      return `<i class="${cls(s.engine && s.engine !== x.id && "is-dim")}" style="width:${x.share * 100}%;background:${D.ENGINE[x.id].color}" data-tip="${t}"></i>`;
    }).join("");
    const cards = shares.map((x) => {
      const on = s.engine === x.id;
      return `<button type="button" class="${cls("ecard", on && "is-on", s.engine && !on && "is-dim")}" data-action="engine" data-engine="${x.id}" aria-pressed="${on}">
        <span class="ecard__name">${engineDot(x.id)}${esc(D.ENGINE[x.id].name)}</span><b>${F.share(x.share)}</b><span class="ecard__sub">${x.models} 个模型 · ${F.tokens(x.total)}</span></button>`;
    }).join("");
    return `<section class="card hero">
      <div class="hero__top">
        <div>
          <p class="kicker">Token 总数${s.engine ? ` · ${esc(D.ENGINE[s.engine].name)}` : ""}</p>
          <p class="hero__num">${F.tokens(sum.total)}</p>
          <p class="hero__sub">${pr.rangeText} · ${span} 天中 ${active} 天有用量${forecast ? ` · 按近 7 个活跃日均值，${pr.period === "custom" ? "区间" : `本${D.UNIT[pr.period]}`}预计约 ${F.tokens(forecast)}` : ""}</p>
        </div>
        <div class="hero__cost">
          <p class="kicker">费用（估算）<span class="info" tabindex="0" role="note" aria-label="费用按价格表估算，订阅套餐实际不按此计费" data-tip="${costTip}">${icon("info")}</span>${p(4)}</p>
          <p class="hero__money">${F.usd(sum.cost)}</p>
          ${cmpHtml}
        </div>
      </div>
      ${warn}
      <div class="sharebar" role="img" aria-label="各引擎用量占比">${bar}</div>
      <div class="ecards">
        <button type="button" class="${cls("ecard", !s.engine && "is-on")}" data-action="engine" data-engine="" aria-pressed="${!s.engine}"><span class="ecard__name">全部</span><b>100%</b><span class="ecard__sub">${allModels} 个模型 · ${F.tokens(shares.reduce((a, x) => a + x.total, 0))}</span></button>
        ${cards}${p(6)}
      </div>
    </section>`;
  }

  /* -------------------------------------------------------------- 趋势 */
  function trend(s, pr) {
    const bs = D.buckets(pr, s.engine, s.trendBy);
    const max = Math.max(1, ...bs.map((b) => Math.max(b.total, b.forecast)));
    const top = D.niceCeil(max);
    const every = bs.length > 16 ? Math.ceil(bs.length / 8) : 1;
    const seen = new Map();
    bs.forEach((b) => b.parts.forEach((part) => { if (part.v > 0) seen.set(part.key, part); }));
    const legend = [...seen.values()].map((l) => `<span><i style="background:${l.color}"></i>${esc(l.name)}</span>`).join("");
    const hasForecast = bs.some((b) => b.forecast);
    const cols = bs.map((b, i) => {
      const segs = b.parts.filter((part) => part.v > 0)
        .map((part) => `<i style="height:${(part.v / b.total) * 100}%;background:${part.color}"></i>`).join("");
      const lines = b.parts.filter((part) => part.v > 0).sort((x, y) => y.v - x.v)
        .map((part) => `<li><i style="background:${part.color}"></i>${esc(part.name)}<b>${F.tokens(part.v)}</b></li>`).join("");
      const tipHtml = b.forecast
        ? `<b>${esc(b.longLabel)}</b><br>预测约 ${F.tokens(b.forecast)}<br><small>近 7 个活跃日的日均值</small>`
        : b.future ? `<b>${esc(b.longLabel)}</b><br>尚未到来`
          : `<b>${esc(b.longLabel)}</b><br>${F.tokens(b.total)} tokens · ${F.usd(b.sum.cost)}${lines ? `<ul class="tip__list">${lines}</ul>` : ""}${b.drill ? "<small>点击查看这一段</small>" : ""}`;
      const label = i % every === 0 ? b.label : "";
      const clickable = b.drill && !b.future;
      const attrs = clickable ? `data-action="drill" data-drill="${b.drill}"` : 'tabindex="-1" aria-disabled="true"';
      return `<button type="button" class="${cls("tcol", b.isNow && "is-now", b.future && "is-future", !clickable && "is-static")}" ${attrs} data-tip="${tip(tipHtml)}" aria-label="${esc(b.longLabel)}：${b.future ? "未到来" : `${F.tokens(b.total)} tokens`}">
        ${b.forecast ? `<span class="tcol__fc" style="height:${(b.forecast / top) * 100}%"></span>` : ""}
        <span class="tcol__stack" style="height:${(b.total / top) * 100}%">${segs}</span>
        <span class="tcol__x">${label}</span></button>`;
    }).join("");
    const grid = [1 / 3, 2 / 3, 1].map((f) => `<span class="tgrid__line" style="bottom:${f * 100}%"><em>${F.tokens(top * f)}</em></span>`).join("");
    return `<section class="card trend">
      <header class="card__head"><h3>趋势${p(7)}</h3>
        <div class="seg seg--xs" role="radiogroup" aria-label="堆叠方式">
          <button type="button" role="radio" aria-checked="${s.trendBy === "engine"}" data-action="trend-by" data-by="engine">按引擎</button>
          <button type="button" role="radio" aria-checked="${s.trendBy === "model"}" data-action="trend-by" data-by="model">按模型</button>
        </div>
        <div class="legend">${legend}${hasForecast ? '<span><i class="lg-fc"></i>预测</span>' : ""}</div>
      </header>
      <div class="tchart"><div class="tgrid">${grid}</div><div class="tcols" role="group" aria-label="趋势柱，可用左右方向键移动">${cols}</div></div>
    </section>`;
  }

  /* -------------------------------------------------------------- 明细 */
  const TIME_COL = { hour: "时间", day: "日期", week: "周", month: "月份" };
  const COLS = {
    time: (pr) => [["key", TIME_COL[pr.gran]], ["total", "总计"], ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读"], ["cacheWrite", "缓存写"], ["reasoning", "推理"], ["requests", "请求"], ["cost", "费用"]],
    project: () => [["name", "项目"], ["total", "总计"], ["share", "占比"], ["requests", "请求"], ["cost", "费用"], ["last", "最近活跃"]],
    model: () => [["model", "模型"], ["engine", "引擎"], ["total", "总计"], ["input", "输入"], ["output", "输出"], ["cacheRead", "缓存读"], ["cost", "费用"], ["priced", "价格"]],
  };

  function tableRows(s, pr) {
    if (s.table === "project") return D.projectRanking(pr.from, pr.to, s.engine);
    if (s.table === "model") return D.modelRanking(pr.from, pr.to, s.engine);
    return D.buckets(pr, s.engine, "engine").filter((b) => !b.future && b.total > 0)
      .map((b, i) => ({ ...b.sum, key: b.key, order: i, label: b.longLabel, drill: b.drill }));
  }

  function sortRows(rows, sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    const k = sort.key === "key" ? "order" : sort.key;
    return [...rows].sort((a, b) => {
      const x = a[k] ?? -1;
      const y = b[k] ?? -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * dir;
    });
  }

  function cell(tab, key, r) {
    const num = (v) => `<td class="num">${F.tokens(v)}</td>`;
    if (key === "key") return `<td>${esc(r.label)}</td>`;
    if (key === "name") return `<td><b>${esc(r.name)}</b><code class="path">${esc(r.path || "不在任何已登记的工作区内")}</code></td>`;
    if (key === "model") return `<td><b class="mono">${esc(r.model)}</b></td>`;
    if (key === "engine") return `<td>${engineDot(r.engine)}${esc(D.ENGINE[r.engine].name)}</td>`;
    if (key === "share") return `<td><span class="minibar"><i style="width:${r.share * 100}%"></i></span>${F.share(r.share)}</td>`;
    if (key === "requests") return `<td class="num">${F.int(r.requests)}</td>`;
    if (key === "cost") return `<td class="num">${r.unknownTokens && !r.cost ? '<span class="is-muted">—</span>' : F.usd(r.cost)}</td>`;
    if (key === "last") return `<td>${r.last ? F.dateZh(D.fromKey(r.last)) : "—"}</td>`;
    if (key === "priced") return `<td>${r.priced ? '<span class="is-muted">价格表</span>' : '<span class="is-warn">未知价格</span>'}</td>`;
    return num(r[key]);
  }

  function table(s, pr) {
    const cols = COLS[s.table](pr);
    const sort = s.sort[s.table];
    const rows = sortRows(tableRows(s, pr), sort);
    const reasonTip = tip("推理 tokens 已包含在「输出」里，单列只供参考，不重复计入总计。");
    const head = cols.map(([key, label]) => {
      const active = sort.key === key;
      const aria = active ? (sort.dir === "asc" ? "ascending" : "descending") : "none";
      const info = key === "reasoning" ? `<span class="info" data-tip="${reasonTip}">${icon("info")}</span>` : "";
      return `<th aria-sort="${aria}" class="${["key", "name", "model", "engine", "last", "priced", "share"].includes(key) ? "" : "num"}"><button type="button" data-action="sort" data-sort="${key}">${label}${info}<span class="sortc">${active ? (sort.dir === "asc" ? "↑" : "↓") : ""}</span></button></th>`;
    }).join("");
    const body = rows.length ? rows.map((r) => {
      const click = s.table === "time" && r.drill ? `class="is-click" tabindex="0" data-action="drill" data-drill="${r.drill}"`
        : s.table === "project" ? `class="is-click" tabindex="0" data-action="project" data-project="${r.id}"` : "";
      return `<tr ${click}>${cols.map(([key]) => cell(s.table, key, r)).join("")}</tr>`;
    }).join("") : `<tr><td colspan="${cols.length}" class="dt__empty">这个周期没有用量</td></tr>`;
    const tabsHtml = [["time", `按${TIME_COL[pr.gran]}`], ["project", "按项目"], ["model", "按模型"]].map(([id, label]) =>
      `<button type="button" role="tab" aria-selected="${s.table === id}" data-action="table" data-table="${id}">${label}</button>`).join("");
    return `<section class="card dtable" id="dtable">
      <header class="card__head"><div class="seg seg--xs" role="tablist" aria-label="明细维度">${tabsHtml}</div>${p(8)}${p(9)}<span class="card__meta">${rows.length} 行</span></header>
      <div class="dt-wrap"><table class="dt"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    </section>`;
  }

  /* -------------------------------------------------------------- 侧栏卡 */
  function stats(s, pr, sum) {
    const active = D.activeDays(pr.from, pr.to, s.engine);
    const span = D.daysBetween(pr.from, endOf(pr)) + 1;
    const tile = (label, value, sub) => `<div class="stile"><b>${value}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;
    const totalActive = D.activeDays(D.FIRST_DAY, D.TODAY);
    return `<section class="card stats">
      <div class="stiles">
        ${tile("日均", F.tokens(active ? sum.total / active : 0), "按有用量的天")}
        ${tile("活跃天数", `${active}<em>/ ${span}</em>`, "")}
        ${tile("请求", F.int(sum.requests), "模型响应次数")}
        ${tile("会话", F.int(sum.sessions), "")}
      </div>
      <p class="stats__foot"><span>首次使用 ${D.keyOf(D.FIRST_DAY)}</span><span>累计 ${totalActive} 天有用量</span></p>
    </section>`;
  }

  function models(s, pr) {
    const list = D.modelRanking(pr.from, pr.to, s.engine);
    const item = (m, i) => `<li><span class="rank">${i + 1}</span><span class="mname">${engineDot(m.engine)}<span class="mono">${esc(m.model)}</span></span><b>${F.share(m.share)}</b><span class="mbar"><i style="width:${m.share * 100}%;background:${D.ENGINE[m.engine].color}"></i></span></li>`;
    const top = list.slice(0, 5);
    const rest = list.slice(5);
    const more = rest.length
      ? `<div class="${cls("collapse", s.modelsOpen && "is-open")}" data-collapse="models" ${s.modelsOpen ? "" : 'aria-hidden="true" inert'}><div class="collapse__in"><ol class="mlist">${rest.map((m, i) => item(m, i + 5)).join("")}</ol></div></div>
         <button type="button" class="lnk lnk--more" data-action="models-toggle" aria-expanded="${s.modelsOpen}">${s.modelsOpen ? "收起" : `展开全部（${list.length}）`}${icon("chevD", s.modelsOpen ? "is-flip" : "")}</button>`
      : "";
    return `<section class="card models"><header class="card__head"><h3>模型排行${p(11)}</h3><span class="card__meta">按 tokens</span></header>
      ${list.length ? `<ol class="mlist">${top.map(item).join("")}</ol>${more}` : '<p class="is-muted">没有数据</p>'}
    </section>`;
  }

  function heatmap(s, pr) {
    const cells = D.heatCells(s.engine);
    const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
    const months = weeks.map((wk, i) => {
      const m = wk[0].date.getMonth();
      const prev = i ? weeks[i - 1][0].date.getMonth() : -1;
      return m !== prev ? `<span style="grid-column:${i + 1}">${m + 1}月</span>` : "";
    }).join("");
    const inRange = (c) => c.date >= pr.from && c.date <= pr.to;
    const html = cells.map((c) => {
      if (c.future) return '<i class="hm is-future"></i>';
      const t = tip(`<b>${F.dateWeekZh(c.date)}</b><br>${c.total ? `${F.tokens(c.total)} tokens · ${F.usd(c.cost)}` : "没有用量"}`);
      return `<button type="button" class="${cls("hm", `l${c.level}`, !inRange(c) && "is-out", c.key === D.keyOf(D.TODAY) && "is-today")}" data-action="drill" data-drill="day:${c.key}" data-tip="${t}" aria-label="${F.dateWeekZh(c.date)}：${c.total ? `${F.tokens(c.total)} tokens` : "没有用量"}"></button>`;
    }).join("");
    return `<section class="card heat"><header class="card__head"><h3>热力图${p(10)}</h3><span class="card__meta">近 26 周</span></header>
      <div class="heat__wrap">
        <div class="heat__days"><span>一</span><span></span><span>三</span><span></span><span>五</span><span></span><span></span></div>
        <div class="heat__main"><div class="heat__months">${months}</div><div class="heat__grid">${html}</div></div>
      </div>
      <div class="heat__legend"><span>少</span><i class="hm l0"></i><i class="hm l1"></i><i class="hm l2"></i><i class="hm l3"></i><i class="hm l4"></i><span>多</span><span class="heat__note">当前周期外的格子变淡</span></div>
    </section>`;
  }

  /* -------------------------------------------------------- 首次扫描 / 空 */
  function scanning() {
    const items = [["Claude Code", "1,284 个文件", "done"], ["Codex", "37 个文件", "done"], ["oh-my-pi", "812 / 2,210", "run"], ["Pi", "等待中", "wait"], ["Kimi Code", "等待中", "wait"], ["DeepSeek Harness", "等待中", "wait"]];
    return `<div class="ov">
      <section class="card scan">${p(13)}
        <div class="scan__head">${icon("loader", "spin")}<b>正在统计本机用量</b><span class="scan__pct">37%</span></div>
        <span class="progress"><i style="width:37%"></i></span>
        <p>第一次需要读取全部历史会话日志（1,284 / 3,460 个文件），之后只增量读取新内容。可以先去做别的，完成后这里会自动刷新。</p>
        <ul class="scan__list">${items.map(([n, t, st]) => `<li class="is-${st}">${st === "done" ? icon("check") : st === "run" ? icon("loader", "spin") : "<i></i>"}<b>${n}</b><span>${t}</span></li>`).join("")}</ul>
      </section>
      <div class="skel-grid"><div class="skel skel--hero"></div><div class="skel skel--card"></div><div class="skel skel--card"></div></div>
    </div>`;
  }

  function empty() {
    return `<div class="ov"><section class="card empty">${p(13)}
      ${mascot(44, { still: true })}
      <h3>还没有用量记录</h3>
      <p>在 CC GUI 或任一受支持的 CLI 里完成一次对话后，这里会自动出现统计。</p>
      <details class="empty__dirs"><summary>查找过的目录（${D.SOURCES.length}）</summary><ul>${D.SOURCES.map((src) => `<li><b>${src.name}</b><code>${src.dir}</code></li>`).join("")}</ul></details>
    </section></div>`;
  }

  /* -------------------------------------------------------------- 浮层 */
  function rangeLayer(s) {
    const draft = s.draft;
    const right = D.fromKey(s.calMonth);
    const months = [D.addMonths(right, -1), right];
    const inDraft = (k) => draft.from && draft.to && k >= draft.from && k <= draft.to;
    const month = (m) => {
      const first = D.startOfMonth(m);
      const lead = (first.getDay() + 6) % 7;
      const days = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
      const blanks = Array.from({ length: lead }, () => "<span></span>").join("");
      const cellsHtml = Array.from({ length: days }, (_, i) => {
        const d = new Date(m.getFullYear(), m.getMonth(), i + 1);
        const k = D.keyOf(d);
        const disabled = d > D.TODAY;
        return `<button type="button" class="${cls("cal__d", inDraft(k) && "is-in", k === draft.from && "is-start", k === draft.to && "is-end", k === D.keyOf(D.TODAY) && "is-today")}" data-action="range-day" data-key="${k}" ${disabled ? "disabled" : ""}>${i + 1}</button>`;
      }).join("");
      return `<div class="cal__m"><p>${m.getFullYear()}年${m.getMonth() + 1}月</p><div class="cal__g"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span>${blanks}${cellsHtml}</div></div>`;
    };
    const n = draft.from && draft.to ? D.daysBetween(D.fromKey(draft.from), D.fromKey(draft.to)) + 1 : 0;
    const tooLong = n > 366;
    const summary = !draft.to ? '<span class="is-muted">选择结束日期</span>'
      : tooLong ? `<span class="is-error">最长 366 天（当前 ${n} 天）</span>`
        : `${F.dateZh(D.fromKey(draft.from))} – ${F.dateZh(D.fromKey(draft.to))} · ${n} 天`;
    const presets = [["7", "近 7 天"], ["30", "近 30 天"], ["90", "近 90 天"], ["ytd", "今年"]];
    const canNext = D.addMonths(right, 1) <= D.TODAY;
    return `<div class="lay lay--range" data-layer-for="range" role="dialog" aria-label="自定义日期区间">
      <div class="range">
        <div class="range__presets">${presets.map(([v, l]) => `<button type="button" class="range__p" data-action="range-preset" data-days="${v}">${l}</button>`).join("")}</div>
        <div class="range__cal">
          <div class="range__nav"><button type="button" class="ibtn ibtn--sm" data-action="cal-nav" data-dir="-1" aria-label="上个月">${icon("chevL")}</button><button type="button" class="ibtn ibtn--sm" data-action="cal-nav" data-dir="1" aria-label="下个月" ${canNext ? "" : "disabled"}>${icon("chevR")}</button></div>
          <div class="cal">${months.map(month).join("")}</div>
        </div>
      </div>
      <footer class="lay__foot lay__foot--split"><span>${summary}</span><span class="lay__btns"><button type="button" class="btn btn--sm btn--ghost" data-action="range-cancel">取消</button><button type="button" class="btn btn--sm btn--primary" data-action="range-apply" ${draft.to && !tooLong ? "" : "disabled"}>应用</button></span></footer>
    </div>`;
  }

  function drawer(s) {
    const pr = D.periodRange(s.period, s.anchor, s.range);
    const proj = D.PROJECT[s.drawer];
    const rows = D.rowsBetween(pr.from, endOf(pr), s.engine).filter((r) => r.project === proj.id);
    const sum = D.sumRows(rows);
    const byEngine = D.ENGINES.map((e) => ({ e, v: D.sumRows(rows.filter((r) => r.engine === e.id)).total })).filter((x) => x.v > 0);
    const modelMap = new Map();
    rows.forEach((r) => modelMap.set(r.model, (modelMap.get(r.model) || 0) + r.total));
    const modelList = [...modelMap.entries()].sort((a, b) => b[1] - a[1]);
    const days = Array.from({ length: 30 }, (_, i) => D.addDays(D.TODAY, i - 29));
    const daily = days.map((d) => D.sumRows(D.rowsBetween(d, d, s.engine).filter((r) => r.project === proj.id)).total);
    const dmax = Math.max(1, ...daily);
    return `<div class="drawer-scrim" data-action="close-drawer"></div>
      <aside class="drawer" role="dialog" aria-label="项目用量：${esc(proj.name)}">
        <header class="drawer__head"><div><h3>${esc(proj.name)}</h3><code class="path">${esc(proj.path || "不在任何已登记的工作区内")}</code></div><button type="button" class="ibtn" data-action="close-drawer" aria-label="关闭" title="关闭">${icon("x")}</button></header>
        <p class="kicker">${esc(pr.label)}${s.engine ? ` · ${esc(D.ENGINE[s.engine].name)}` : ""}</p>
        <div class="drawer__nums"><div><span>总计</span><b>${F.tokens(sum.total)}</b></div><div><span>费用</span><b>${F.usd(sum.cost)}</b></div><div><span>请求</span><b>${F.int(sum.requests)}</b></div></div>
        <p class="kicker">按引擎</p>
        <div class="sharebar sharebar--sm">${byEngine.map((x) => `<i style="width:${(x.v / (sum.total || 1)) * 100}%;background:${x.e.color}"></i>`).join("")}</div>
        <ul class="kv">${byEngine.map((x) => `<li>${engineDot(x.e.id)}${esc(x.e.name)}<b>${F.tokens(x.v)}</b></li>`).join("")}</ul>
        <p class="kicker">按模型</p>
        <ul class="kv">${modelList.map(([m, v]) => `<li><span class="mono">${esc(m)}</span><b>${F.tokens(v)}</b></li>`).join("") || '<li class="is-muted">没有数据</li>'}</ul>
        <p class="kicker">近 30 天</p>
        <div class="mini">${daily.map((v, i) => `<i style="height:${Math.max(2, (v / dmax) * 100)}%" data-tip="${tip(`${F.dateWeekZh(days[i])}<br>${F.tokens(v)} tokens`)}"></i>`).join("")}</div>
        ${proj.path ? `<footer class="drawer__foot"><button type="button" class="btn btn--sm" data-action="locate" data-ws="${proj.id}">${icon("folder")}在侧栏定位工作区</button></footer>` : ""}
      </aside>`;
  }

  function overlays(s) {
    if (s.scanning || s.empty) return "";
    const parts = [];
    if (s.layer === "range") parts.push(rangeLayer(s));
    if (s.drawer) parts.push(drawer(s));
    return parts.join("");
  }

  window.ULOverview = { overview, overlays };
})();
