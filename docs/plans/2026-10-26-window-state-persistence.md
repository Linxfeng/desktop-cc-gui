# 窗口状态持久化：记住大小、位置、最大化与全屏

日期：2026-10-26
状态：已实现，实机验收通过（Windows；macOS 同 DPI 双屏，见 §8。macOS 混合 DPI 仅单测覆盖）
对应上游 issue：[#1381](https://github.com/zhukunpenglinyutong/desktop-cc-gui/issues/1381)（记住窗口大小与位置，macOS 报告）

## 1. 背景与问题定义

主窗口在 `src-tauri/src/lib.rs` 的 setup 里手工创建，几何参数是硬编码：

```rust
WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
    .title("CC GUI")
    .inner_size(1400.0, 900.0)
    .min_inner_size(900.0, 600.0)
```

没有位置参数，也没有任何持久化。用户调整大小、最大化或进入全屏后退出，下次启动
一律回到 1400×900 的由系统摆放的位置。上游 #1381 的诉求是「记住宽高和位置，
不要每次都很小且不居中」；本地实测同样复现，并额外包括最大化/全屏不恢复。

## 2. 现状核对

- `tauri.conf.json` 已不声明窗口（窗口改在 setup 创建），无配置项可用；
- 依赖里没有 `tauri-plugin-window-state`；
- `settings.json` 由 `settings.rs` 的 `SETTINGS_WRITE_LOCK` 串行化
  read-modify-write，并且是设置面板的 schema（前端 `AppSettings` 逐字段对应）；
- `on_window_event` 已在 `lib.rs` 注册，当前只处理 `Destroyed` 的 teardown；
- `pet-overlay` 是独立窗口，不属于本功能范围。

## 3. 方案

新增 `src-tauri/src/window_state.rs`，用独立的 `window-state.json` 保存主窗口
几何与状态，启动时校验后恢复，运行期防抖保存。

### 3.1 为什么不用 tauri-plugin-window-state

- 插件默认恢复 `VISIBLE` / `DECORATIONS` 等 flags，与本项目 Windows「仿 mac
  无边框」设置（`decorations(false)` + `shadow(true)`）叠加会产生平台差异；
- 多显示器越界、最大化时保留普通尺寸这两条策略需要自定义，插件不提供钩子；
- 本项目已有一套原子写与错误处理约定，独立模块约 200 行即可覆盖，引入依赖
  换来的是需要绕开的行为。

### 3.2 为什么不复用 settings.json

窗口几何在拖动/缩放时每秒变化多次，而 `settings.json` 的写入是全局串行化的
read-modify-write（配对密钥轮换、relay 地址持久化等都走这条路）。高频写入会
与设置面板的保存竞争并放大丢字段的风险；同时窗口状态不是用户可配置项，放进
设置 schema 会让前端类型多出一组不应暴露的字段。独立文件、独立节流，互不干扰。

### 3.3 记录内容

`window-state.json`（位于 `paths::app_home()` 下，与 `settings.json` 同级）：

```json
{
  "width": 2100, "height": 1350, "x": 120, "y": 80,
  "scaleFactor": 1.5,
  "maximized": false, "fullscreen": false
}
```

- 宽高与位置取自 `inner_size()` / `outer_position()`，单位跟随平台：Windows/Linux
  用**物理像素**（虚拟屏幕坐标统一），macOS 用**逻辑点**（tao 按窗口当前所在屏的
  倍数换算物理像素、各显示器也各按自己的倍数换算，混合 DPI 时物理坐标对不齐，
  只有点坐标是统一的，见 §8）；`scaleFactor` 仅用于诊断，不参与恢复；
- `maximized` / `fullscreen` 单独记录。

### 3.4 关键策略

**A. 最大化/全屏时不覆盖普通几何。**
最大化后 `inner_size()` 返回的是屏幕尺寸；若把它当成普通态尺寸保存，用户取消
最大化后就再也回不到原来的窗口大小。规则：只有在非最大化且非全屏时更新几何，
任何时刻都更新两个布尔标志。

**B. 恢复顺序与防闪烁。**
`.visible(false)` 建窗 → 校验/应用几何（`set_position(PhysicalPosition)` +
`set_size(PhysicalSize)`）→ 按标志 `set_maximized` / `set_fullscreen` →
`show()`。这样不会先闪一下 1400×900 再跳到目标位置。macOS 的原生全屏需要窗口
可见才能进入 space 动画，故 macOS 在 `show()` 之后再 `set_fullscreen(true)`，
其余平台在 show 之前设置。

**C. 越界校验（多显示器）。**
保存的矩形必须与某个显示器工作区有足够交集（宽度与高度各至少 120 px 且交集
面积不少于窗口自身面积的 20%），否则丢弃几何、退回默认。这样拔掉副屏、改分辨
率或改变缩放后不会出现「窗口在屏幕外」的不可用状态。

**D. 尺寸钳制。**
恢复的宽高限制在 `[min_inner_size(900×600), 目标显示器工作区尺寸]` 之间，避免
小屏上恢复出超出屏幕的窗口。目标显示器是与窗口交集最大的那块屏，逻辑最小尺寸
按**它自己**的缩放系数换算（不是主屏的）。位置只做越界校验，不强制拉回屏幕内
（用户把窗口故意放在边缘是合法状态）。

**E. 无有效记录时居中。**
首次启动或记录无效时用 1400×900 并 `center()`，修复 #1381 提到的「位置没有
居中」。

**F. 写入节流与退出兜底。**
`Resized` / `Moved` 事件只更新内存快照并标记 dirty，单个后台线程在最后一次
变化 500 ms 后落盘；`CloseRequested` / `Destroyed` 立即 flush，避免拖完窗口
马上退出而丢失最后一次变化。macOS 空闲时的 ⌘Q / 程序坞退出不经过这两个窗口
事件（见 `quit_guard.rs`），因此 `RunEvent::Exit` 里同样 flush。写盘复用
`settings::atomic_write`（写临时文件后 rename，崩溃不留半截 JSON）。

**G. 损坏/不可读降级。**
解析失败、字段缺失、尺寸为 0 或超出合理上限（例如 20000 px）都视为无记录，
按默认值启动并覆盖写回；读失败只 `eprintln` 一行，不阻断启动。

### 3.5 模块接口

```rust
// 启动前：读文件 + 校验，给出可应用的几何与标志
pub fn resolve_saved(monitors: &[MonitorRect], min: (u32, u32)) -> Restored;

// 建窗后：应用几何、最大化/全屏、show()，然后安装事件跟踪
pub fn attach(window: &WebviewWindow) -> Result<(), String>;

// 退出前：立即落盘
pub fn flush();
```

纯函数（`visible_enough`、`clamp_size`、`geometry_after_event`、`parse_state`）
与 IO 分离，单测不需要真实窗口。

### 3.6 与现有设置的关系

- 不改 `AppSettings`、不动前端设置面板，本功能无用户可见开关；
- 与 `titlebar` 设置无耦合：几何用 `outer_position` / `inner_size` 记录，装饰
  切换只改变 frame 厚度，不影响窗口内容区大小；
- `pet-overlay`、插件自定义窗口不参与跟踪。

## 4. 非目标

- 不做「每个工作区恢复不同窗口布局」，不引入多窗口记忆；
- 不恢复 `decorations` / `visible` / `theme` 等其它窗口 flags；
- 不提供「重置窗口位置」的 UI 或命令：越界校验已覆盖不可用场景；
- 不改 web / remote 模式（窗口状态只与桌面主窗口有关）。

## 5. 测试计划

单元测试（`window_state.rs`，纯函数 + scratch 目录）：

1. 几何越界：保存的矩形在已断开的副屏上 → 丢弃几何、返回默认；与主屏有足够
   交集 → 保留；
2. 尺寸钳制：保存 3000×2000、目标屏 1920×1080 → 恢复为不超过工作区；低于最小
   尺寸 → 抬到 900×600；
3. 最大化策略：最大化事件不覆盖已保存的普通几何；取消最大化后恢复到原尺寸；
4. 解析降级：缺字段 / 尺寸 0 / 上限溢出 / 非 JSON → 全部回退默认值，不 panic；
5. 文件 round-trip：写入后读出一致；损坏文件覆盖写回后读出默认值。

实机验收（Windows）：

1. 调整窗口大小与位置 → 退出 → 重开：尺寸与位置一致；
2. 最大化 → 退出 → 重开：最大化；取消最大化后回到之前的普通尺寸；
3. 全屏 → 退出 → 重开：全屏；退出全屏后回到之前的尺寸；
4. 首启（删除 window-state.json）：1400×900 且居中；
5. 拖动过程中直接退出（不等 500 ms）：下次启动保留最后一次拖动结果；
6. 手写一份 x/y 在屏幕外的记录 → 启动：窗口落在默认位置，可正常操作。

macOS 需人工确认原生全屏恢复（space 动画）与红绿灯/Overlay 标题栏无冲突。

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 最大化尺寸被当作普通尺寸保存 | 策略 A，单测 3 覆盖 |
| 多显示器变更导致窗口不可见 | 策略 C，单测 1 覆盖 |
| 高频写盘拖慢拖动 | 500 ms 防抖 + 单线程写，退出时 flush |
| 写盘中断留下坏文件 | 复用 `atomic_write`；解析失败降级 |
| macOS 全屏恢复时序 | show() 后再 set_fullscreen；实机确认 |
| DPI 变化后物理尺寸映射不同 | 坐标单位跟随平台（Windows/Linux 物理像素、macOS 逻辑点），最小尺寸按目标显示器倍数换算；记录 scaleFactor 供诊断 |

## 7. 实施记录（2026-10-26）

落地时实测暴露并修正的四个问题：

1. **最大化时刻的标志竞态**：Windows 上 `Resized` 事件先于 `is_maximized()` 变真，
   在事件回调里采样会把整屏尺寸记成普通几何。改为事件只标记 dirty，落盘前（静默
   500 ms 后）统一重采样；退出时同样重采样。
2. **`Destroyed` 把标志清零**：关闭时窗口已失效，采样拿到错误的 false。窗口读不到
   几何时不再覆盖快照。
3. **隐藏窗口的 maximize 无效**：`.visible(false)` 上设置最大化被忽略；且若先最大化
   再摆几何，系统记录的「还原矩形」是默认值，取消最大化会跳回错误尺寸。最终顺序
   固定为：摆位置 → 定尺寸 → show → maximize。
4. **系统对恢复尺寸的钳制**：窗口大于当前工作区时系统会改小，启动后按实际几何
   回填内存快照，避免永远保存一个偏大的请求值。

另外把默认摆放从「交给系统 + center()」改成显式居中到主显示器工作区：多显示器
混合 DPI 下系统摆放不稳定（实测同一构建两次启动落在不同显示器）。

单测 11 个全部通过；实机验证（Windows，双显示器混合 DPI）：默认居中、缩放持久化、
最大化恢复与取消最大化回到原尺寸、全屏恢复且普通几何不被覆盖。

## 8. 合并前补充修正（2026-10-27）

评审时对照 tauri 2.11.5 / tao 0.35.3 源码并在 macOS 实机复核，修正四个问题：

1. **macOS 混合 DPI 恢复到错的显示器**：tao 在 macOS 上 `outer_position()` /
   `set_position()` 按「窗口当前所在屏」的倍数换算物理像素，显示器工作区又各按
   自己的倍数换算。Retina 内建屏（2x）+ 1x 外接屏时，外接屏上保存的物理坐标在
   恢复时被内建屏的倍数除，窗口落到内建屏、尺寸减半后被抬到最小值。改为 macOS
   记录、校验、摆放一律用逻辑点（`LOGICAL_UNITS`），Windows/Linux 仍用物理像素。
2. **最小尺寸按主屏倍数换算**：混合 DPI 下副屏上合法的小窗口被撑大（主屏 150%、
   副屏 100% 时 1000×700 恢复成 1350×900）。改为按目标显示器自己的倍数换算。
3. **macOS ⌘Q 不落盘**：空闲时的 ⌘Q / 程序坞退出不触发 `CloseRequested` /
   `Destroyed`，最后 500 ms 内的变化丢失。`RunEvent::Exit` 里补一次 `flush()`。
4. **macOS 最大化/全屏恢复后普通几何被默认值覆盖**：tao 在 macOS 上的
   `set_position` / `set_size` / `maximize` / `set_fullscreen` 派发到主队列异步执行，
   `show()` 却是同步的。启动时立即回填快照（原 `adopt_actual_geometry`）读到的是
   建窗时的 1400×900 且「未最大化」，覆盖了普通几何；窗口随后被最大化，这份默认
   几何就一直保留，取消最大化回不到原尺寸。改为启动时只标记 dirty，由写盘线程在
   静默 500 ms 后统一重采样。

验证：

- 单测 15 个全部通过（原 11 个断言不变，新增目标显示器倍数、主屏默认尺寸、macOS
  混合 DPI 点坐标恢复、异常缩放系数兜底 4 个）。
- macOS 实机（双 4K 显示器，均为 2x）：主屏 / 副屏恢复位置与尺寸精确一致；越界
  记录退回主屏居中 1400×900；副屏上最大化恢复后普通几何保持 1000×700；全屏恢复
  且普通几何不变；以 Cocoa terminate（与 ⌘Q 同路径）在 500 ms 防抖前退出，修复前
  3/3 次不落盘、修复后 5/5 次落盘。最大化用例在修正 4 之前同样复现（原始提交也会
  把普通几何写成 1400×900）。
- 未覆盖：macOS 混合 DPI 实机（手头无 1x 外接屏，仅单测覆盖）、Windows 与 Linux
  本次未重新实机验证（这几处改动在 Windows/Linux 上的行为：最小尺寸换算改用目标
  显示器倍数、启动回填改为延迟重采样、退出时多一次 flush）。
