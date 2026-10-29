/* ===========================================================================
 * 用量与限额 · 设计稿示例数据与计算（不是产品代码）
 *
 * 固定随机种子 + 固定「现在」（2026-10-27 21:06），每次打开结果一致。
 * 价格是示例值，不是任何厂商的真实报价；落地时价格来自宿主价格表。
 * 聚合 / 周期 / 限额节奏的算法即落地时宿主数据层要实现的语义。
 * ======================================================================== */
(function () {
  "use strict";

  const NOW = new Date(2026, 9, 27, 21, 6, 0);
  const FIRST_DAY = new Date(2026, 4, 11);
  const DAY_MS = 86400000;
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function next() {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }

  /* ------------------------------------------------------------------ 日期 */
  const pad = (n) => String(n).padStart(2, "0");
  const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = (k) => {
    const [y, m, d] = k.split("-").map(Number);
    return new Date(y, m - 1, d);
  };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const startOfWeek = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
  const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = (d) => new Date(d.getFullYear(), d.getMonth() + 1, 0);
  const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / DAY_MS);
  const minDate = (a, b) => (a < b ? a : b);
  const maxDate = (a, b) => (a > b ? a : b);
  const TODAY = startOfDay(NOW);

  /* --------------------------------------------------------------- 字典 */
  const ENGINES = [
    { id: "omp", name: "oh-my-pi", mark: "π", color: "var(--c-lime)" },
    { id: "pi", name: "Pi", mark: "Pi", color: "var(--c-blue)" },
    { id: "claude", name: "Claude Code", mark: "C", color: "var(--c-yellow)" },
    { id: "kimi", name: "Kimi Code", mark: "K", color: "var(--c-purple)" },
    { id: "codex", name: "Codex", mark: "Cx", color: "var(--c-sky)" },
    { id: "dsh", name: "DeepSeek Harness", mark: "D", color: "var(--c-emerald)" },
  ];
  const ENGINE = Object.fromEntries(ENGINES.map((e) => [e.id, e]));

  const ENGINE_MODELS = {
    omp: [["deepseek-v4-flash", 0.62], ["kimi-k2.5", 0.18], ["claude-sonnet-5-5", 0.12], ["gpt-5.5", 0.08]],
    pi: [["deepseek-flash", 0.86], ["kimi-k2.5", 0.14]],
    claude: [["claude-opus-5-5", 0.8], ["claude-fable-5-1", 0.12], ["claude-haiku-5-5", 0.08]],
    kimi: [["kimi-k2.5", 1]],
    codex: [["gpt-5.5", 0.72], ["gpt-5.5-mini", 0.28]],
    dsh: [["deepseek-v4-pro", 1]],
  };

  /* 示例价格：美元 / 百万 tokens [输入, 输出, 缓存读, 缓存写]。null = 价格表里查不到。 */
  const PRICES = {
    "claude-opus-5-5": [5, 25, 0.5, 6.25],
    "claude-fable-5-1": [15, 75, 1.5, 18.75],
    "claude-sonnet-5-5": [3, 15, 0.3, 3.75],
    "claude-haiku-5-5": [1, 5, 0.1, 1.25],
    "gpt-5.5": [1.25, 10, 0.125, 0],
    "gpt-5.5-mini": [0.25, 2, 0.025, 0],
    "deepseek-v4-flash": [0.14, 0.28, 0.014, 0],
    "deepseek-flash": [0.14, 0.28, 0.014, 0],
    "kimi-k2.5": [0.6, 2.5, 0.15, 0],
    "deepseek-v4-pro": null,
  };

  const PROJECTS = [
    { id: "ccgui", name: "desktop-cc-gui", path: "~/Desktop/CCGUI 项目/desktop-cc-gui", w: 0.46 },
    { id: "jb", name: "jetbrains-cc-gui", path: "~/Desktop/CCGUI 项目/jetbrains-cc-gui", w: 0.16 },
    { id: "plugins", name: "ccgui-plugins", path: "~/Desktop/CCGUI 项目/ccgui-plugins", w: 0.14 },
    { id: "vs", name: "vscode-cc-gui", path: "~/Desktop/CCGUI 项目/vscode-cc-gui", w: 0.12 },
    { id: "wt", name: "pr-1455-922", path: "~/Desktop/CCGUI 项目/desktop-cc-gui-worktrees/pr-1455-922", w: 0.07 },
    { id: "other", name: "其他目录", path: null, w: 0.05 },
  ];
  const PROJECT = Object.fromEntries(PROJECTS.map((p) => [p.id, p]));

  const SOURCES = [
    { id: "claude", name: "Claude Code", dir: "~/.claude/projects", env: "CLAUDE_CONFIG_DIR", files: 1284, status: "ok" },
    { id: "omp", name: "oh-my-pi", dir: "~/.omp/agent/sessions", files: 2210, status: "ok" },
    { id: "pi", name: "Pi", dir: "~/.pi/agent/sessions", files: 861, status: "ok" },
    { id: "kimi", name: "Kimi Code", dir: "~/.kimi/sessions", files: 112, status: "ok" },
    { id: "codex", name: "Codex", dir: "~/.codex/sessions", env: "CODEX_HOME", files: 37, status: "ok" },
    { id: "dsh", name: "DeepSeek Harness", dir: "~/.dsh", env: "DSH_HOME", files: 4, status: "ok" },
    { id: "codebuddy", name: "CodeBuddy", dir: "~/.codebuddy/projects", status: "missing" },
    { id: "grok", name: "Grok", dir: "~/.grok/sessions", status: "missing" },
    { id: "opencode", name: "OpenCode", dir: "~/.local/share/opencode/opencode.db", status: "missing" },
    { id: "qoder", name: "Qoder", dir: "~/.qoder", status: "denied" },
  ];

  /* ------------------------------------------------------------- 生成明细 */
  const rand = mulberry32(20261027);
  const PROJECT_WEIGHTS = PROJECTS.map((p) => [p.id, p.w]);

  function pick(weighted) {
    const r = rand();
    let acc = 0;
    for (const [item, w] of weighted) {
      acc += w;
      if (r <= acc) return item;
    }
    return weighted[weighted.length - 1][0];
  }

  function engineMix(t) {
    if (t < 70) return { claude: 0.64, codex: 0.22, kimi: 0.14 };
    if (t < 128) return { claude: 0.42, omp: 0.28, pi: 0.14, kimi: 0.09, codex: 0.07 };
    return { omp: 0.479, pi: 0.307, claude: 0.187, kimi: 0.027, codex: 0.0045, dsh: 0.00006 };
  }

  function splitTokens(total) {
    const cacheRead = Math.round(total * (0.9 + rand() * 0.06));
    const rest = total - cacheRead;
    const input = Math.round(rest * 0.36);
    const output = Math.round(rest * 0.21);
    const cacheWrite = rest - input - output;
    const reasoning = Math.round(output * (0.2 + rand() * 0.25));
    const requests = Math.max(1, Math.round(total / (140e3 + rand() * 90e3)));
    const sessions = Math.max(1, Math.round(requests / (28 + rand() * 30)));
    return { input, output, cacheRead, cacheWrite, reasoning, requests, sessions };
  }

  function rescale(rows, target) {
    const sum = rows.reduce((a, r) => a + r.input + r.output + r.cacheRead + r.cacheWrite, 0);
    const k = target / sum;
    const scale = (v) => Math.round(v * k);
    return rows.map((r) => ({
      ...r,
      input: scale(r.input),
      output: scale(r.output),
      cacheRead: scale(r.cacheRead),
      cacheWrite: scale(r.cacheWrite),
      reasoning: scale(r.reasoning),
      requests: Math.max(1, scale(r.requests)),
    }));
  }

  function costOf(model, t) {
    const p = PRICES[model];
    if (!p) return null;
    return (p[0] * t.input + p[1] * t.output + p[2] * t.cacheRead + p[3] * t.cacheWrite) / 1e6;
  }

  function generateRows() {
    const dayCount = daysBetween(FIRST_DAY, TODAY) + 1;
    const out = [];
    for (let t = 0; t < dayCount; t += 1) {
      const date = addDays(FIRST_DAY, t);
      const isToday = t === dayCount - 1;
      const weekend = date.getDay() === 0 || date.getDay() === 6;
      const idle = rand() < (t < 60 ? 0.3 : 0.07);
      if (idle && !isToday) continue;
      const base = 30e6 * Math.exp(t / 58);
      const dayTotal = base * (weekend ? 0.5 : 1) * (0.55 + rand() * 0.9);
      const dayRows = [];
      for (const [engine, share] of Object.entries(engineMix(t))) {
        const engineTotal = dayTotal * share * (0.75 + rand() * 0.5);
        for (const [model, modelShare] of ENGINE_MODELS[engine]) {
          const total = Math.round(engineTotal * modelShare);
          if (total < 2000) continue;
          dayRows.push({ day: keyOf(date), engine, model, project: pick(PROJECT_WEIGHTS), ...splitTokens(total) });
        }
      }
      out.push(...(isToday ? rescale(dayRows, 463.3e6) : dayRows));
    }
    return out.map((r) => ({
      ...r,
      total: r.input + r.output + r.cacheRead + r.cacheWrite,
      cost: costOf(r.model, r),
    }));
  }

  const ROWS = generateRows();
  const BY_DAY = new Map();
  ROWS.forEach((r) => BY_DAY.set(r.day, [...(BY_DAY.get(r.day) || []), r]));

  /* ---------------------------------------------------------------- 聚合 */
  const SUM_KEYS = ["total", "input", "output", "cacheRead", "cacheWrite", "reasoning", "requests", "sessions"];

  function sumRows(rows, k = 1) {
    const acc = { cost: 0, unknownTokens: 0, unknownModels: [] };
    SUM_KEYS.forEach((key) => { acc[key] = 0; });
    const unknown = new Set();
    rows.forEach((r) => {
      SUM_KEYS.forEach((key) => { acc[key] += r[key] * k; });
      if (r.cost == null) {
        acc.unknownTokens += r.total * k;
        unknown.add(r.model);
      } else {
        acc.cost += r.cost * k;
      }
    });
    return { ...acc, unknownModels: [...unknown] };
  }

  function rowsBetween(from, to, engine) {
    const out = [];
    for (let d = startOfDay(from); d <= to; d = addDays(d, 1)) {
      (BY_DAY.get(keyOf(d)) || []).forEach((r) => {
        if (!engine || r.engine === engine) out.push(r);
      });
    }
    return out;
  }

  const sumRange = (from, to, engine) => sumRows(rowsBetween(from, minDate(to, TODAY), engine));

  function activeDays(from, to, engine) {
    let n = 0;
    for (let d = startOfDay(from); d <= minDate(to, TODAY); d = addDays(d, 1)) {
      if ((BY_DAY.get(keyOf(d)) || []).some((r) => !engine || r.engine === engine)) n += 1;
    }
    return n;
  }

  const HOUR_SHAPE = [0.18, 0.1, 0.05, 0.03, 0.02, 0.02, 0.04, 0.12, 0.35, 0.75, 1, 0.95,
    0.6, 0.75, 1, 1, 0.92, 0.85, 0.6, 0.7, 0.9, 0.85, 0.62, 0.38];

  function hourFractions(dayKey) {
    const r = mulberry32(hashStr(dayKey));
    const isToday = dayKey === keyOf(TODAY);
    const raw = HOUR_SHAPE.map((v, h) => (isToday && h > NOW.getHours() ? 0 : v * (0.6 + r() * 0.8)));
    const s = raw.reduce((a, b) => a + b, 0);
    return raw.map((v) => v / s);
  }

  /** 今日到「现在」为止 vs 昨日同一时刻为止。 */
  function todayVsYesterday() {
    const today = sumRange(TODAY, TODAY).total;
    const y = addDays(TODAY, -1);
    const frac = hourFractions(keyOf(y)).slice(0, NOW.getHours() + 1).reduce((a, b) => a + b, 0);
    const prev = sumRange(y, y).total * frac;
    return prev > 0 ? today / prev - 1 : null;
  }

  function recentDailyAvg(engine) {
    const vals = [];
    for (let d = addDays(TODAY, -1); vals.length < 7 && d >= FIRST_DAY; d = addDays(d, -1)) {
      const v = sumRange(d, d, engine).total;
      if (v > 0) vals.push(v);
    }
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
  }

  /* ---------------------------------------------------------------- 周期 */
  const UNIT = { day: "天", week: "周", month: "月", year: "年" };
  const THIS_UNIT = { day: "今天", week: "本周", month: "本月", year: "今年" };
  const dateZh = (d) => `${d.getMonth() + 1}月${d.getDate()}日`;
  const dateWeekZh = (d) => `${dateZh(d)} ${WEEKDAYS[d.getDay()]}`;

  function periodRange(period, anchorKey, range) {
    const a = fromKey(anchorKey);
    const make = (from, to, gran, label) => ({
      period, from, to, gran, label,
      containsToday: from <= TODAY && TODAY <= to,
      rangeText: `${dateZh(from)} – ${dateZh(minDate(to, TODAY))}`,
    });
    if (period === "day") return make(a, a, "hour", `${dateWeekZh(a)}${keyOf(a) === keyOf(TODAY) ? "（今天）" : ""}`);
    if (period === "week") {
      const f = startOfWeek(a);
      return make(f, addDays(f, 6), "day", `${dateZh(f)} – ${dateZh(addDays(f, 6))}`);
    }
    if (period === "month") return make(startOfMonth(a), endOfMonth(a), "day", `${a.getFullYear()}年${a.getMonth() + 1}月`);
    if (period === "year") return make(new Date(a.getFullYear(), 0, 1), new Date(a.getFullYear(), 11, 31), "month", `${a.getFullYear()}年`);
    if (period === "custom") {
      const f = fromKey(range.from);
      const t = fromKey(range.to);
      return make(f, t, daysBetween(f, t) + 1 > 62 ? "week" : "day", `${dateZh(f)} – ${dateZh(t)}`);
    }
    return make(FIRST_DAY, TODAY, "month", `全部（自 ${FIRST_DAY.getFullYear()}年${dateZh(FIRST_DAY)}）`);
  }

  function shiftAnchor(period, anchorKey, dir) {
    const a = fromKey(anchorKey);
    if (period === "day") return keyOf(addDays(a, dir));
    if (period === "week") return keyOf(addDays(a, dir * 7));
    if (period === "month") return keyOf(addMonths(a, dir));
    if (period === "year") return keyOf(new Date(a.getFullYear() + dir, 0, 1));
    return anchorKey;
  }

  function canShift(period, anchorKey, range, dir) {
    if (period === "all" || period === "custom") return false;
    const next = periodRange(period, shiftAnchor(period, anchorKey, dir), range);
    return dir > 0 ? next.from <= TODAY : next.to >= FIRST_DAY;
  }

  /** 与上一同长周期比较；当前周期只比到「同期」（同样经过的天数 / 小时）。 */
  function compare(pr, engine) {
    if (pr.period === "all") return null;
    const cur = sumRange(pr.from, pr.to, engine).total;
    if (pr.period === "day") {
      const prevDay = addDays(pr.from, -1);
      const frac = pr.containsToday
        ? hourFractions(keyOf(prevDay)).slice(0, NOW.getHours() + 1).reduce((a, b) => a + b, 0)
        : 1;
      const prev = sumRange(prevDay, prevDay, engine).total * frac;
      return prev > 0 ? { delta: cur / prev - 1, label: pr.containsToday ? "较昨日同时" : "较前一天" } : null;
    }
    const span = daysBetween(pr.from, pr.to) + 1;
    const elapsed = daysBetween(pr.from, minDate(pr.to, TODAY)) + 1;
    let prevFrom;
    if (pr.period === "month") prevFrom = addMonths(pr.from, -1);
    else if (pr.period === "year") prevFrom = new Date(pr.from.getFullYear() - 1, 0, 1);
    else prevFrom = addDays(pr.from, -span);
    const prev = sumRange(prevFrom, addDays(prevFrom, elapsed - 1), engine).total;
    const names = { week: "上周", month: "上月", year: "去年", custom: `前 ${span} 天` };
    const label = pr.containsToday && pr.period !== "custom" ? `较${names[pr.period]}同期` : `较${names[pr.period]}`;
    return prev > 0 ? { delta: cur / prev - 1, label } : null;
  }

  /* --------------------------------------------------------------- 趋势桶 */
  const MODEL_COLORS = ["var(--c-lime)", "var(--c-blue)", "var(--c-purple)", "var(--c-pink)", "var(--c-yellow)", "var(--c-emerald)"];

  function seriesDefs(pr, engine, by) {
    if (by === "engine") return ENGINES.map((e) => ({ key: e.id, name: e.name, color: e.color }));
    const totals = modelRanking(pr.from, pr.to, engine);
    const top = totals.slice(0, 6).map((m, i) => ({ key: m.model, name: m.model, color: MODEL_COLORS[i] }));
    return totals.length > 6 ? [...top, { key: "__other", name: "其他", color: "var(--c-gray)" }] : top;
  }

  function splitParts(rows, defs, by, k) {
    const keys = new Set(defs.map((d) => d.key));
    const vals = Object.fromEntries(defs.map((d) => [d.key, 0]));
    rows.forEach((r) => {
      const raw = by === "engine" ? r.engine : r.model;
      const key = keys.has(raw) ? raw : "__other";
      if (key in vals) vals[key] += r.total * k;
    });
    return defs.map((d) => ({ ...d, v: vals[d.key] }));
  }

  function rawBuckets(pr) {
    if (pr.gran === "hour") {
      const fr = hourFractions(keyOf(pr.from));
      const isToday = keyOf(pr.from) === keyOf(TODAY);
      return fr.map((f, h) => ({
        key: `h${h}`, label: `${h}`, longLabel: `${dateZh(pr.from)} ${pad(h)}:00–${pad(h + 1)}:00`,
        from: pr.from, to: pr.from, k: f, future: isToday && h > NOW.getHours(), isNow: isToday && h === NOW.getHours(), drill: null,
      }));
    }
    const out = [];
    if (pr.gran === "day") {
      for (let d = pr.from; d <= pr.to; d = addDays(d, 1)) {
        out.push({ key: keyOf(d), label: `${d.getDate()}`, longLabel: dateWeekZh(d), from: d, to: d, k: 1,
          future: d > TODAY, isNow: keyOf(d) === keyOf(TODAY), drill: `day:${keyOf(d)}` });
      }
      return out;
    }
    if (pr.gran === "week") {
      for (let d = pr.from; d <= pr.to; d = addDays(d, 7)) {
        const end = minDate(addDays(d, 6), pr.to);
        out.push({ key: `w${keyOf(d)}`, label: `${d.getMonth() + 1}/${d.getDate()}`, longLabel: `${dateZh(d)} – ${dateZh(end)}`,
          from: d, to: end, k: 1, future: d > TODAY, isNow: d <= TODAY && TODAY <= end, drill: `week:${keyOf(d)}` });
      }
      return out;
    }
    for (let m = startOfMonth(pr.from); m <= pr.to; m = addMonths(m, 1)) {
      out.push({ key: `m${keyOf(m)}`, label: `${m.getMonth() + 1}月`, longLabel: `${m.getFullYear()}年${m.getMonth() + 1}月`,
        from: maxDate(m, pr.from), to: minDate(endOfMonth(m), pr.to), k: 1, future: m > TODAY,
        isNow: m <= TODAY && TODAY <= endOfMonth(m), drill: `month:${keyOf(m)}` });
    }
    return out;
  }

  function buckets(pr, engine, by) {
    const defs = seriesDefs(pr, engine, by);
    const avg = pr.gran === "day" && pr.containsToday ? recentDailyAvg(engine) : 0;
    return rawBuckets(pr).map((b) => {
      const rows = b.future ? [] : rowsBetween(b.from, b.to, engine);
      const sum = sumRows(rows, b.k);
      return { ...b, sum, total: sum.total, parts: splitParts(rows, defs, by, b.k), forecast: b.future && avg ? avg : 0 };
    });
  }

  function forecastTotal(pr, engine) {
    if (!pr.containsToday || pr.gran !== "day") return null;
    const futureDays = daysBetween(TODAY, pr.to);
    return futureDays > 0 ? sumRange(pr.from, pr.to, engine).total + futureDays * recentDailyAvg(engine) : null;
  }

  function niceCeil(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    const n = v / p;
    const step = [1, 1.5, 2, 3, 4, 5, 6, 8, 10].find((x) => n <= x) || 10;
    return step * p;
  }

  /* -------------------------------------------------------------- 分组 */
  function groupBy(rows, keyFn) {
    const map = new Map();
    rows.forEach((r) => map.set(keyFn(r), [...(map.get(keyFn(r)) || []), r]));
    return map;
  }

  function engineShares(from, to) {
    const rows = rowsBetween(from, minDate(to, TODAY));
    const all = sumRows(rows).total || 1;
    const g = groupBy(rows, (r) => r.engine);
    return ENGINES.filter((e) => g.has(e.id)).map((e) => {
      const rs = g.get(e.id);
      const total = sumRows(rs).total;
      return { id: e.id, total, share: total / all, models: new Set(rs.map((r) => r.model)).size };
    }).sort((a, b) => b.total - a.total);
  }

  function modelRanking(from, to, engine) {
    const rows = rowsBetween(from, minDate(to, TODAY), engine);
    const all = sumRows(rows).total || 1;
    return [...groupBy(rows, (r) => r.model).entries()].map(([model, rs]) => {
      const sum = sumRows(rs);
      return { model, engine: rs[0].engine, ...sum, share: sum.total / all, priced: PRICES[model] != null };
    }).sort((a, b) => b.total - a.total);
  }

  function projectRanking(from, to, engine) {
    const rows = rowsBetween(from, minDate(to, TODAY), engine);
    const all = sumRows(rows).total || 1;
    return [...groupBy(rows, (r) => r.project).entries()].map(([id, rs]) => {
      const sum = sumRows(rs);
      const last = rs.reduce((m, r) => (r.day > m ? r.day : m), "");
      return { id, name: PROJECT[id].name, path: PROJECT[id].path, ...sum, share: sum.total / all, last };
    }).sort((a, b) => b.total - a.total);
  }

  /* ---------------------------------------------------------------- 热力图 */
  function heatCells(engine) {
    const end = addDays(startOfWeek(TODAY), 6);
    const start = addDays(end, -26 * 7 + 1);
    const cells = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const s = d > TODAY ? null : sumRange(d, d, engine);
      cells.push({ key: keyOf(d), date: d, total: s ? s.total : 0, cost: s ? s.cost : 0, future: d > TODAY });
    }
    const vals = cells.filter((c) => c.total > 0).map((c) => c.total).sort((a, b) => a - b);
    const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))] || 0;
    const cuts = [q(0.25), q(0.5), q(0.75), q(0.9)];
    return cells.map((c) => ({ ...c, level: c.total <= 0 ? 0 : 1 + cuts.filter((x) => c.total > x).length }));
  }

  /* ---------------------------------------------------------------- 限额 */
  const win = (id, label, short, used, windowSec, resetInSec, scoped = false) =>
    ({ id, label, short, used, windowSec, resetInSec, scoped });
  const H = 3600;
  const LIMIT_OK = {
    claude: {
      name: "Claude", plan: "Max 20x", host: "api.anthropic.com", cmd: "claude",
      windows: [
        win("5h", "5 小时", "5h", 52, 5 * H, 72 * 60),
        win("7d", "7 天", "7d", 37, 168 * H, 28 * H),
        win("fable", "7 天 · Fable", "Fable", 2, 168 * H, 28 * H, true),
      ],
      extra: { used: 12.4, limit: 50 },
    },
    codex: {
      name: "Codex", plan: "Pro", host: "chatgpt.com", cmd: "codex login",
      windows: [
        win("5h", "5 小时", "5h", 8, 5 * H, 242 * 60),
        win("7d", "每周", "7d", 71, 168 * H, 51 * H),
      ],
      extra: null,
    },
  };

  /** 预览开关 → 某个平台的限额读取结果。status 即落地时宿主返回的状态枚举。 */
  function limitsFor(id, preview, tight) {
    const base = LIMIT_OK[id];
    const windows = id === "claude" && tight
      ? base.windows.map((w) => (w.id === "5h" ? { ...w, used: 86, resetInSec: 185 * 60 } : w))
      : base.windows;
    const ok = { ...base, windows, status: "ok", agoSec: 120 };
    switch (preview) {
      case "loading": return { ...ok, status: "loading", windows: [], agoSec: null };
      case "signedOut": return { ...ok, status: "signedOut", plan: null, windows: [], extra: null, agoSec: null };
      case "expired": return { ...ok, status: "expired", windows: [], extra: null, agoSec: null };
      case "rateLimited": return { ...ok, status: "rateLimited", agoSec: 360, retryInSec: 120 };
      case "offline": return { ...ok, status: "offline", agoSec: 1500 };
      case "weekly": return { ...ok, plan: "Free", windows: [win("7d", "每周", "7d", 46, 168 * H, 78 * H)] };
      default: return ok;
    }
  }

  /**
   * 节奏：marker = 时间进度（窗口已过去的比例）；按目前的平均速率线性外推到重置时刻。
   * 预计在重置前用完 → over（给出还能用多久、比重置早多久），否则 ok（给出预计用到多少）。
   */
  function pace(w) {
    const used = w.used / 100;
    const elapsed = Math.min(Math.max(1 - w.resetInSec / w.windowSec, 0), 1);
    if (used <= 0) return { kind: "idle", marker: null };
    if (elapsed < 0.03) return { kind: "early", marker: elapsed };
    const projected = used / elapsed;
    if (projected < 1) return { kind: "ok", marker: elapsed, projected };
    const ratePerSec = used / (elapsed * w.windowSec);
    const runOutSec = (1 - used) / ratePerSec;
    return { kind: "over", marker: elapsed, projected, runOutSec, earlySec: w.resetInSec - runOutSec };
  }

  /* ---------------------------------------------------------------- 格式 */
  const trim1 = (x) => String(Math.round(x * 10) / 10);
  const fmt = {
    tokens(n) {
      if (n == null) return "—";
      const a = Math.abs(n);
      if (a >= 1e9) return `${trim1(n / 1e9)}B`;
      if (a >= 1e6) return `${trim1(n / 1e6)}M`;
      if (a >= 1e3) return `${trim1(n / 1e3)}K`;
      return String(Math.round(n));
    },
    usd(n) {
      if (n == null) return "—";
      if (n >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
      return `$${n.toFixed(2)}`;
    },
    int: (n) => Math.round(n).toLocaleString("en-US"),
    share(x) {
      if (x > 0 && x < 0.0001) return "<0.01%";
      const p = x * 100;
      return `${p >= 10 ? p.toFixed(1) : p.toFixed(2)}%`;
    },
    dur(sec) {
      const m = Math.max(0, Math.round(sec / 60));
      if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
      if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
      return `${m}m`;
    },
    durZh(sec) {
      const m = Math.max(0, Math.round(sec / 60));
      if (m >= 1440) {
        const h = Math.floor((m % 1440) / 60);
        return `${Math.floor(m / 1440)} 天${h ? ` ${h} 小时` : ""}`;
      }
      if (m >= 60) return `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ""}`;
      return `${Math.max(1, m)} 分钟`;
    },
    ago(sec) {
      if (sec == null) return "";
      if (sec < 30) return "刚刚";
      if (sec < 3600) return `${Math.round(sec / 60)} 分钟前`;
      return `${Math.round(sec / 3600)} 小时前`;
    },
    resetAt(sec) {
      const t = new Date(NOW.getTime() + sec * 1000);
      const dd = daysBetween(TODAY, t);
      const hm = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
      if (dd === 0) return `今天 ${hm}`;
      if (dd === 1) return `明天 ${hm}`;
      return `${dateWeekZh(t)} ${hm}`;
    },
    dateZh,
    dateWeekZh,
  };

  window.ULData = {
    NOW, TODAY, FIRST_DAY, ENGINES, ENGINE, PROJECTS, PROJECT, PRICES, SOURCES, UNIT, THIS_UNIT,
    keyOf, fromKey, addDays, addMonths, startOfMonth, startOfWeek, daysBetween, minDate,
    sumRows, rowsBetween, sumRange, activeDays, hourFractions, todayVsYesterday,
    periodRange, shiftAnchor, canShift, compare, buckets, forecastTotal, niceCeil,
    engineShares, modelRanking, projectRanking, heatCells, limitsFor, pace, fmt,
  };
})();
