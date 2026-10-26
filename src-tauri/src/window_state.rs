//! 主窗口几何与状态持久化（上游 issue #1381）。
//!
//! 窗口大小/位置/最大化/全屏在退出时丢失，重开一律回到硬编码的 1400×900 与
//! 系统摆放的位置。这里用独立的 `window-state.json` 记住这些状态，与
//! `settings.json` 解耦：窗口几何在拖动时每秒变多次，而 settings.json 的写入
//! 是全局串行化的 read-modify-write，混在一起会放大丢字段的风险。
//!
//! 三条关键语义：
//! - **最大化/全屏不覆盖普通几何**：最大化后 `inner_size()` 返回屏幕尺寸，
//!   当成普通尺寸保存后用户就再也回不到原窗口大小；
//! - **越界即丢弃**：保存的矩形必须与某个显示器工作区有足够交集，否则该副屏
//!   已断开（或分辨率/缩放变了），恢复默认居中的窗口；
//! - **写盘节流**：Resized/Moved 只更新内存快照，最后一次变化 500 ms 后落盘，
//!   退出时立即 flush。写文件复用 `settings::atomic_write`，崩溃不留半截 JSON。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow};

/// 默认窗口尺寸（逻辑像素），与建窗时的初始值一致。
const DEFAULT_WIDTH: f64 = 1400.0;
const DEFAULT_HEIGHT: f64 = 900.0;
/// 与建窗时的 `min_inner_size` 保持一致。
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;
/// 最后一次几何变化后等待这么久再落盘，避免拖动过程中高频写文件。
const DEBOUNCE: Duration = Duration::from_millis(500);
/// 窗口矩形与显示器工作区的最小交集：宽高各至少这么多物理像素，且面积占比
/// 不低于 20%。低于阈值视为该显示器已不可用（拔掉副屏、改分辨率/缩放）。
const MIN_INTERSECT_PX: i64 = 120;
const MIN_INTERSECT_RATIO: f64 = 0.2;
/// 明显不合理的历史记录（显示器尺寸上限之外）按损坏处理。
const MAX_DIMENSION: u32 = 20_000;

/// 物理像素矩形，纯数据，便于单测不依赖真实窗口。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }
    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }
    fn area(&self) -> f64 {
        f64::from(self.width) * f64::from(self.height)
    }
    /// `(宽度交集, 高度交集)`，都不小于 0。
    fn intersection(&self, other: &Rect) -> (i64, i64) {
        let w = self.right().min(other.right()) - i64::from(self.x).max(i64::from(other.x));
        let h = self.bottom().min(other.bottom()) - i64::from(self.y).max(i64::from(other.y));
        (w.max(0), h.max(0))
    }
}

/// 落盘内容。宽高是 `inner_size()`（物理像素），位置是 `outer_position()`。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedState {
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    /// 仅用于诊断（跨 DPI 显示器时物理像素与逻辑尺寸的换算依据）。
    #[serde(default)]
    pub scale_factor: f64,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub fullscreen: bool,
}

impl SavedState {
    fn geometry(&self) -> Rect {
        Rect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
    }

    /// 结构上像一条可用记录：尺寸在合理区间内、位置未明显溢出。
    fn is_plausible(&self) -> bool {
        self.width >= 1
            && self.height >= 1
            && self.width <= MAX_DIMENSION
            && self.height <= MAX_DIMENSION
            && self.x.abs() < MAX_DIMENSION as i32
            && self.y.abs() < MAX_DIMENSION as i32
    }
}

/// 启动时决定怎么摆放窗口。
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Placement {
    /// 有可用记录：应用保存的几何。
    Restore(Rect),
    /// 没有记录 / 记录损坏 / 记录落在已不存在的显示器上：默认尺寸，居中放在
    /// 主显示器（monitors[0]）的工作区里。位置和尺寸都显式算好，不用系统的
    /// 「窗口摆在哪」——多显示器混合 DPI 下系统摆放不稳定。
    Default(Rect),
}

/// 恢复结论：几何 + 两个状态标志。
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Resolution {
    pub placement: Placement,
    pub maximized: bool,
    pub fullscreen: bool,
}

/// 默认摆放：尺寸按主显示器工作区收缩逻辑像素的 1400×900，并居中。
fn default_placement(monitors: &[Rect], scale_factor: f64) -> Rect {
    let scale = scale_factor.max(1.0);
    let width = (DEFAULT_WIDTH * scale).round() as u32;
    let height = (DEFAULT_HEIGHT * scale).round() as u32;
    let Some(primary) = monitors.first() else {
        return Rect { x: 0, y: 0, width, height };
    };
    let width = width.min(primary.width);
    let height = height.min(primary.height);
    Rect {
        x: primary.x + (i64::from(primary.width) - i64::from(width)).max(0) as i32 / 2,
        y: primary.y + (i64::from(primary.height) - i64::from(height)).max(0) as i32 / 2,
        width,
        height,
    }
}

impl Resolution {
    fn fallback(monitors: &[Rect], scale_factor: f64) -> Self {
        Self {
            placement: Placement::Default(default_placement(monitors, scale_factor)),
            maximized: false,
            fullscreen: false,
        }
    }
}

/// 保存的矩形与某个显示器工作区是否有足够交集。交集过小说明该屏幕已不可用，
/// 恢复过去会得到看不见、也拖不回来的窗口。
fn visible_enough(rect: &Rect, monitors: &[Rect]) -> bool {
    monitors.iter().any(|monitor| {
        let (w, h) = rect.intersection(monitor);
        if w < MIN_INTERSECT_PX || h < MIN_INTERSECT_PX {
            return false;
        }
        let area = f64::from(w as u32) * f64::from(h as u32);
        area >= rect.area() * MIN_INTERSECT_RATIO
    })
}

/// 把恢复的尺寸钳制到目标显示器工作区与最小尺寸之间。
///
/// `scale_factor` 用于把逻辑的最小尺寸换成物理像素；工作区取与矩形交集最大的
/// 那一块（`visible_enough` 已保证至少有一块交集足够）。工作区永远优先于最小
/// 尺寸：高 DPI 屏上 900×600 逻辑可能换算成比屏幕还大的物理尺寸，此时让步给
/// 屏幕，否则会恢复出一个比显示器还大的窗口。
fn clamp_size(rect: Rect, monitors: &[Rect], scale_factor: f64) -> Rect {
    let target = monitors
        .iter()
        .max_by_key(|monitor| {
            let (w, h) = rect.intersection(monitor);
            w.saturating_mul(h)
        })
        .copied();
    let min_w = (MIN_WIDTH * scale_factor.max(1.0)).round() as u32;
    let min_h = (MIN_HEIGHT * scale_factor.max(1.0)).round() as u32;
    let (max_w, max_h) = target
        .map(|monitor| (monitor.width, monitor.height))
        .unwrap_or((MAX_DIMENSION, MAX_DIMENSION));
    let clamp_axis = |value: u32, min: u32, max: u32| value.max(min.min(max)).min(max);
    Rect {
        width: clamp_axis(rect.width, min_w, max_w),
        height: clamp_axis(rect.height, min_h, max_h),
        ..rect
    }
}

/// 解析 + 校验 + 钳制，得到可应用的结论。纯函数，单测直接喂合成显示器。
pub(crate) fn resolve(
    saved: Option<&SavedState>,
    monitors: &[Rect],
    scale_factor: f64,
) -> Resolution {
    let Some(saved) = saved.filter(|state| state.is_plausible()) else {
        return Resolution::fallback(monitors, scale_factor);
    };
    if monitors.is_empty() || !visible_enough(&saved.geometry(), monitors) {
        // 显示器信息拿不到时也不冒险恢复：宁可默认居中，也不把窗口放到未知位置。
        return Resolution::fallback(monitors, scale_factor);
    }
    Resolution {
        placement: Placement::Restore(clamp_size(saved.geometry(), monitors, scale_factor)),
        maximized: saved.maximized,
        fullscreen: saved.fullscreen,
    }
}

/// 事件驱动的快照更新规则。
///
/// 最大化/全屏期间 `inner_size()` 是屏幕尺寸，不能覆盖普通几何；标志本身任何
/// 时刻都记录。返回新快照（`None` 表示这次事件不值得关注）。
pub(crate) fn state_after_event(
    previous: &SavedState,
    size: (u32, u32),
    position: (i32, i32),
    maximized: bool,
    fullscreen: bool,
    scale_factor: f64,
) -> SavedState {
    let mut next = previous.clone();
    if !maximized && !fullscreen && size.0 > 0 && size.1 > 0 {
        next.width = size.0;
        next.height = size.1;
        next.x = position.0;
        next.y = position.1;
        next.scale_factor = scale_factor;
    }
    next.maximized = maximized;
    next.fullscreen = fullscreen;
    next
}

// ==================== 磁盘 ====================

pub(crate) fn state_path() -> PathBuf {
    crate::paths::app_home().join("window-state.json")
}

fn read_at(path: &Path) -> Option<SavedState> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<SavedState>(&text) {
        Ok(state) if state.is_plausible() => Some(state),
        Ok(_) => {
            eprintln!("[window] ignoring implausible window-state.json");
            None
        }
        Err(error) => {
            eprintln!("[window] ignoring unreadable window-state.json: {error}");
            None
        }
    }
}

fn write_at(path: &Path, state: &SavedState) {
    let Ok(json) = serde_json::to_string_pretty(state) else {
        return;
    };
    if let Err(error) = crate::settings::atomic_write(path, &format!("{json}\n")) {
        eprintln!("[window] failed to persist window state: {error}");
    }
}

// ==================== 运行期跟踪 ====================

struct Tracker {
    window: WebviewWindow,
    path: PathBuf,
    state: SavedState,
    dirty: bool,
    last_change: Instant,
}

static TRACKER: parking_lot::Mutex<Option<Tracker>> = parking_lot::Mutex::new(None);

/// 按窗口**当前**状态合并快照。
///
/// 读取时机是关键：Windows 上最大化/还原时 `Resized` 事件先于窗口标志更新，
/// 在事件回调里读 `is_maximized()` 会拿到 false，把屏幕尺寸当成普通尺寸记下来，
/// 之后取消最大化就回不到原窗口大小。因此几何与标志一律在落盘前（事件已静默
/// 500 ms）重新采样，而不是在事件时刻。
/// 窗口已经销毁时读不到几何：返回 `None`，调用方保留原快照。
/// （`Destroyed` 之后也走一次 flush，那时 `is_maximized()` 会报错并被当成
/// false，若照常采样会把「最大化」标志抹掉。）
fn sample(window: &WebviewWindow, previous: &SavedState) -> Option<SavedState> {
    let (Ok(size), Ok(position)) = (window.inner_size(), window.outer_position()) else {
        return None;
    };
    Some(state_after_event(
        previous,
        (size.width, size.height),
        (position.x, position.y),
        window.is_maximized().unwrap_or(false),
        window.is_fullscreen().unwrap_or(false),
        window.scale_factor().unwrap_or(1.0),
    ))
}

/// 取一份锁外的采样任务：窗口句柄 + 当前快照。窗口 API 会同步等待主线程，
/// 必须在释放跟踪表锁之后再调用，否则主线程处理窗口事件时抢同一把锁会死锁。
fn take_job() -> Option<(WebviewWindow, SavedState, PathBuf, Instant, bool)> {
    let guard = TRACKER.lock();
    let tracker = guard.as_ref()?;
    Some((
        tracker.window.clone(),
        tracker.state.clone(),
        tracker.path.clone(),
        tracker.last_change,
        tracker.dirty,
    ))
}

/// 采样完成后写回。`expected` 是采样开始时的快照：期间若有新事件改变了快照，
/// 说明这次采样已经过时，保持 dirty 让下一轮重来。
fn commit(job_state: SavedState, next: SavedState) -> Option<(PathBuf, SavedState)> {
    let mut guard = TRACKER.lock();
    let tracker = guard.as_mut()?;
    if tracker.state != job_state {
        return None;
    }
    tracker.dirty = false;
    if next == job_state {
        // 采样后发现什么都没变（例如只是鼠标悬停触发的事件）：不落盘。
        return None;
    }
    tracker.state = next.clone();
    Some((tracker.path.clone(), next))
}

/// 只更新内存快照，不落盘：用于启动后按窗口的实际几何纠正恢复请求。
/// 系统可能把恢复的尺寸钳制到工作区，记录要跟着实际值走。
fn adopt_actual_geometry() {
    let Some((window, previous, _, _, _)) = take_job() else {
        return;
    };
    let Some(next) = sample(&window, &previous) else {
        return;
    };
    let mut guard = TRACKER.lock();
    if let Some(tracker) = guard.as_mut() {
        if tracker.state == previous {
            tracker.state = next;
        }
    }
}

/// 落盘线程只在第一次跟踪时启动；它按 200 ms 粒度检查「最后一次变化是否
/// 已静默超过 DEBOUNCE」，满足才写盘，因此拖动过程中不会产生写放大。
fn ensure_writer() {
    static STARTED: std::sync::Once = std::sync::Once::new();
    STARTED.call_once(|| {
        std::thread::Builder::new()
            .name("window-state-writer".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_millis(200));
                let Some((window, previous, _path, last_change, dirty)) = take_job() else {
                    continue;
                };
                if !dirty || last_change.elapsed() < DEBOUNCE {
                    continue;
                }
                // 落盘前重采样：此时最大化/全屏标志已经稳定。
                let Some(next) = sample(&window, &previous) else {
                    continue;
                };
                if let Some((path, state)) = commit(previous, next) {
                    write_at(&path, &state);
                }
            })
            .ok();
    });
}

/// 事件只负责标记「有变化」；真正的采样在落盘前统一做（见 `sample`）。
fn mark_dirty() {
    let mut guard = TRACKER.lock();
    if let Some(tracker) = guard.as_mut() {
        tracker.dirty = true;
        tracker.last_change = Instant::now();
    }
}

/// 退出路径：先重采样（窗口通常仍然可读），再同步落盘。
pub(crate) fn flush() {
    let Some((window, previous, path, _, _)) = take_job() else {
        return;
    };
    let next = sample(&window, &previous);
    let pending = {
        let mut guard = TRACKER.lock();
        match guard.as_mut() {
            Some(tracker) => {
                // 采样期间没被新事件改写才用新快照，否则沿用最新快照。
                // 窗口已销毁（采样返回 None）时同样只写已有快照。
                if let Some(next) = next.filter(|_| tracker.state == previous) {
                    tracker.state = next;
                }
                tracker.dirty = false;
                Some((path, tracker.state.clone()))
            }
            None => None,
        }
    };
    if let Some((path, state)) = pending {
        write_at(&path, &state);
    }
}

/// 建窗后调用：应用恢复结论、显示窗口，然后开始跟踪后续变化。
///
/// 窗口以 `visible(false)` 建出来，几何与标志先应用再 `show()`，避免先闪一下
/// 默认尺寸再跳到目标位置。macOS 的原生全屏需要窗口可见才能进入 space 动画，
/// 所以那里在 show 之后再切全屏。
pub(crate) fn apply_and_track(
    window: &WebviewWindow,
    resolution: &Resolution,
    saved: Option<SavedState>,
) -> Result<(), String> {
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    match resolution.placement {
        Placement::Restore(rect) => {
            // 先摆位置再定尺寸：先改尺寸时系统会按旧位置/旧显示器的工作区
            // 算一次约束，窗口尺寸随后被改小而记录不一致。
            window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| format!("set window position: {e}"))?;
            window
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(|e| format!("set window size: {e}"))?;
        }
        Placement::Default(rect) => {
            window
                .set_position(PhysicalPosition::new(rect.x, rect.y))
                .map_err(|e| format!("center window: {e}"))?;
            window
                .set_size(PhysicalSize::new(rect.width, rect.height))
                .map_err(|e| format!("set default window size: {e}"))?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        window
            .set_fullscreen(resolution.fullscreen)
            .map_err(|e| format!("set fullscreen: {e}"))?;
    }
    // 最大化在 show 之前设置：几何已经摆好，因此系统记录的「还原矩形」就是
    // 保存的普通几何；show 之后再最大化会先闪一下普通尺寸。
    if resolution.maximized && !resolution.fullscreen {
        window
            .maximize()
            .map_err(|e| format!("maximize window: {e}"))?;
    }
    window.show().map_err(|e| format!("show window: {e}"))?;
    #[cfg(target_os = "macos")]
    {
        window
            .set_fullscreen(resolution.fullscreen)
            .map_err(|e| format!("set fullscreen: {e}"))?;
    }

    // 跟踪器的初始快照取恢复后的实际状态。有可用记录时直接沿用它的普通几何：
    // 最大化/全屏期间测量到的是屏幕尺寸，不能当成普通尺寸写回。
    let initial = saved
        .filter(|state| state.is_plausible())
        .map(|state| SavedState {
            maximized: resolution.maximized,
            fullscreen: resolution.fullscreen,
            scale_factor,
            ..state
        })
        .unwrap_or_else(|| SavedState {
            width: window.inner_size().map(|size| size.width).unwrap_or(0),
            height: window.inner_size().map(|size| size.height).unwrap_or(0),
            x: window.outer_position().map(|p| p.x).unwrap_or(0),
            y: window.outer_position().map(|p| p.y).unwrap_or(0),
            scale_factor,
            maximized: resolution.maximized,
            fullscreen: resolution.fullscreen,
        });
    {
        let mut guard = TRACKER.lock();
        *guard = Some(Tracker {
            window: window.clone(),
            path: state_path(),
            state: initial,
            dirty: false,
            last_change: Instant::now(),
        });
    }
    ensure_writer();
    // 恢复的尺寸可能被系统按工作区钳制：按实际值纠正内存快照，下次落盘
    // （下一次变化或退出）写的是真实几何，而不是永远偏大的请求值。
    adopt_actual_geometry();

    window.on_window_event(|event| match event {
        // 只标记有变化：几何与最大化/全屏标志在落盘前统一重采样，避免事件
        // 时刻的标志与几何不同步（最大化时 `is_maximized()` 会晚一步为 true）。
        tauri::WindowEvent::Resized(_)
        | tauri::WindowEvent::Moved(_)
        | tauri::WindowEvent::ScaleFactorChanged { .. } => mark_dirty(),
        tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => flush(),
        _ => {}
    });
    Ok(())
}

/// 启动流程的入口：读记录、按显示器校验，返回恢复结论（建窗前调用）。
pub(crate) fn restore_plan(app: &tauri::AppHandle) -> (Resolution, Option<SavedState>) {
    let saved = read_at(&state_path());
    let work_area = |monitor: &tauri::Monitor| {
        let area = monitor.work_area();
        Rect {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
        }
    };
    let primary = app.primary_monitor().ok().flatten();
    let scale_factor = primary
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    // monitors[0] 必须是主显示器：默认摆放以它为中心。
    let mut monitors: Vec<Rect> = primary.iter().map(work_area).collect();
    for monitor in app.available_monitors().unwrap_or_default() {
        let rect = work_area(&monitor);
        if !monitors.contains(&rect) {
            monitors.push(rect);
        }
    }
    let resolution = resolve(saved.as_ref(), &monitors, scale_factor);
    (resolution, saved)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn monitor(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    fn state(width: u32, height: u32, x: i32, y: i32) -> SavedState {
        SavedState {
            width,
            height,
            x,
            y,
            scale_factor: 1.0,
            maximized: false,
            fullscreen: false,
        }
    }

    #[test]
    fn restore_keeps_geometry_on_a_visible_monitor() {
        let monitors = [monitor(0, 0, 1920, 1080)];
        let saved = state(1600, 900, 100, 80);
        let resolution = resolve(Some(&saved), &monitors, 1.0);
        assert_eq!(
            resolution.placement,
            Placement::Restore(Rect { x: 100, y: 80, width: 1600, height: 900 })
        );
    }

    #[test]
    fn restore_discards_geometry_on_a_disconnected_monitor() {
        // 保存位置在已拔掉的副屏上：只剩 1920×1080 主屏时不能恢复过去。
        let monitors = [monitor(0, 0, 1920, 1080)];
        let saved = state(1200, 800, 3000, 200);
        assert!(matches!(
            resolve(Some(&saved), &monitors, 1.0).placement,
            Placement::Default { .. }
        ));
    }

    #[test]
    fn restore_discards_geometry_when_no_monitor_information() {
        let saved = state(1200, 800, 0, 0);
        assert!(matches!(
            resolve(Some(&saved), &[], 1.0).placement,
            Placement::Default { .. }
        ));
    }

    #[test]
    fn restore_clamps_oversized_window_to_the_work_area() {
        let monitors = [monitor(0, 0, 1920, 1040)];
        let saved = state(3000, 2000, 0, 0);
        let Placement::Restore(rect) = resolve(Some(&saved), &monitors, 1.0).placement else {
            panic!("expected restore");
        };
        assert_eq!((rect.width, rect.height), (1920, 1040));
    }

    #[test]
    fn default_size_shrinks_to_the_work_area() {
        // 1440×900 屏幕扣掉任务栏只剩 852 高：默认 900 高会压到任务栏下面。
        let monitors = [monitor(0, 0, 1440, 852)];
        assert_eq!(
            resolve(None, &monitors, 1.0).placement,
            Placement::Default(Rect { x: 20, y: 0, width: 1400, height: 852 })
        );
        // 大屏上保持默认尺寸，不放大，并居中。
        assert_eq!(
            resolve(None, &[monitor(0, 0, 2560, 1400)], 1.0).placement,
            Placement::Default(Rect { x: 580, y: 250, width: 1400, height: 900 })
        );
    }

    #[test]
    fn restore_raises_undersized_window_to_the_minimum() {
        let monitors = [monitor(0, 0, 1920, 1080)];
        let saved = state(320, 200, 10, 10);
        let Placement::Restore(rect) = resolve(Some(&saved), &monitors, 1.0).placement else {
            panic!("expected restore");
        };
        assert_eq!((rect.width, rect.height), (900, 600));
    }

    #[test]
    fn implausible_records_fall_back_to_default() {
        for saved in [
            state(0, 900, 0, 0),
            state(1400, 0, 0, 0),
            state(50_000, 900, 0, 0),
            state(1400, 900, 99_999, 0),
        ] {
            assert!(
                matches!(
                    resolve(Some(&saved), &[monitor(0, 0, 1920, 1080)], 1.0).placement,
                    Placement::Default { .. }
                ),
                "{saved:?}"
            );
        }
    }

    #[test]
    fn maximized_never_overwrites_the_normal_geometry() {
        let previous = state(1200, 800, 50, 40);
        // 最大化期间的 inner_size 是整屏尺寸，位置也常变成 0,0。
        let next = state_after_event(&previous, (1920, 1040), (0, 0), true, false, 1.0);
        assert_eq!((next.width, next.height), (1200, 800));
        assert_eq!((next.x, next.y), (50, 40));
        assert!(next.maximized);
        // 取消最大化后恢复普通几何记录。
        let restored = state_after_event(&next, (1200, 800), (50, 40), false, false, 1.0);
        assert_eq!((restored.width, restored.height), (1200, 800));
        assert!(!restored.maximized);
    }

    #[test]
    fn fullscreen_also_preserves_the_normal_geometry() {
        let previous = state(1400, 900, 10, 20);
        let next = state_after_event(&previous, (2560, 1440), (0, 0), false, true, 1.0);
        assert_eq!((next.width, next.height), (1400, 900));
        assert!(next.fullscreen);
    }

    #[test]
    fn resolution_flags_round_trip_through_resolve() {
        let monitors = [monitor(0, 0, 1920, 1080)];
        let mut saved = state(1400, 900, 20, 30);
        saved.maximized = true;
        saved.fullscreen = false;
        let resolution = resolve(Some(&saved), &monitors, 1.0);
        assert!(resolution.maximized);
        assert!(!resolution.fullscreen);
    }

    #[test]
    fn state_file_round_trips_and_recovers_from_corruption() {
        let dir = std::env::temp_dir().join(format!(
            "ccgui-window-state-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("window-state.json");
        let saved = SavedState {
            width: 1600,
            height: 1000,
            x: -40,
            y: 60,
            scale_factor: 1.25,
            maximized: true,
            fullscreen: false,
        };
        write_at(&path, &saved);
        assert_eq!(read_at(&path), Some(saved));
        // 损坏文件按无记录处理，重新写回后恢复可用。
        std::fs::write(&path, "{not json").unwrap();
        assert_eq!(read_at(&path), None);
        let fallback = state(1400, 900, 0, 0);
        write_at(&path, &fallback);
        assert_eq!(read_at(&path), Some(fallback));
        std::fs::remove_dir_all(&dir).ok();
    }
}
