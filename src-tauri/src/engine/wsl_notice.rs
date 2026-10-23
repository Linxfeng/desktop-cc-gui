//! 本机 WSL 运行时的"未确认"通知队列。
//!
//! 中断/退出时按会话回收 Linux 进程(见 [`super::wsl_transport::kill_local_run`]);
//! 发行版不可达、回收超时或 `pkill` 非预期退出时,进程可能仍在运行。设计
//! 要求这种情况**不能静默**(A7 fail-closed),但回收发生在后台任务里,没有
//! 现成的事件通道,所以记进这个进程内队列,由前端在下次刷新会话时取走并
//! 提示一次。只保留最近 [`MAX_NOTICES`] 条,重复的 (distro, run) 合并。

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

const MAX_NOTICES: usize = 20;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslUnprovenNotice {
    pub distro: String,
    pub run_id: String,
    /// 记录时间(Unix ms)。
    pub at_ms: i64,
}

/// 本机 WSL 的运行期提示(前端按 `kind` 映射文案)。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum WslNotice {
    /// 中断/退出时按会话回收失败,发行版内进程可能仍在运行。
    #[serde(rename_all = "camelCase")]
    ExitUnproven {
        distro: String,
        run_id: String,
        at_ms: i64,
    },
    /// 发行版内没有 ripgrep,@-mention 索引已回落到 UNC 遍历(明显更慢)。
    #[serde(rename_all = "camelCase")]
    RgMissing { distro: String, at_ms: i64 },
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn queue() -> &'static Mutex<VecDeque<WslNotice>> {
    static QUEUE: OnceLock<Mutex<VecDeque<WslNotice>>> = OnceLock::new();
    QUEUE.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn push(notice: WslNotice, same: impl Fn(&WslNotice) -> bool) {
    let Ok(mut queue) = queue().lock() else {
        return;
    };
    queue.retain(|n| !same(n));
    queue.push_back(notice);
    while queue.len() > MAX_NOTICES {
        queue.pop_front();
    }
}

/// 记录一次"回收未确认"。同一 (distro, run) 只留最新一条。
pub fn record_unproven(distro: &str, run_id: &str) {
    let distro_owned = distro.to_string();
    let run_owned = run_id.to_string();
    push(
        WslNotice::ExitUnproven {
            distro: distro_owned.clone(),
            run_id: run_owned.clone(),
            at_ms: now_ms(),
        },
        |n| matches!(n, WslNotice::ExitUnproven { distro, run_id, .. } if *distro == distro_owned && *run_id == run_owned),
    );
}

/// 已经提示过缺 rg 的发行版(进程级)。前端关闭提示后,下一次 `@` 回落
/// 不该立刻重新入队(§10 D8);应用重启后重新提示一次是合理的。
fn rg_notified() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static NOTIFIED: OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        OnceLock::new();
    NOTIFIED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// 记录"发行版内没有 rg"。同一发行版每次应用运行只提示一次。
pub fn record_rg_missing(distro: &str) {
    if let Ok(mut notified) = rg_notified().lock() {
        if !notified.insert(distro.to_string()) {
            return;
        }
    }
    let distro_owned = distro.to_string();
    push(
        WslNotice::RgMissing {
            distro: distro_owned.clone(),
            at_ms: now_ms(),
        },
        |n| matches!(n, WslNotice::RgMissing { distro, .. } if *distro == distro_owned),
    );
}

/// 取走全部提示(前端每次刷新会话调用一次;取走后不再重复提示)。
#[tauri::command]
pub fn wsl_take_unproven_notices() -> Vec<WslNotice> {
    queue()
        .lock()
        .map(|mut queue| queue.drain(..).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 队列的 MAX_NOTICES 上限是**全局**的,不是按发行版算的:三个用例各自
    /// 塞十几条就会互相挤掉队首,断言条数的用例因此时好时坏。所以它们必须
    /// 串行 —— 隔离本来就该靠串行,不能靠把断言改成"至少一条"。
    /// 每个用例结束前把自己的条目全部取走,下一个用例起手时队列是空的。
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    // 队列是进程级全局状态,测试并行跑会互相干扰:每个用例用自己的发行版
    // 名隔离,并在开始前清空(只清自己的,避免误伤并发用例的断言)。
    fn take_own(distro: &str) -> Vec<WslNotice> {
        let mut own = Vec::new();
        let Ok(mut queue) = queue().lock() else {
            return own;
        };
        let mut keep = VecDeque::new();
        while let Some(notice) = queue.pop_front() {
            let mine = match &notice {
                WslNotice::ExitUnproven { distro: d, .. } => d == distro,
                WslNotice::RgMissing { distro: d, .. } => d == distro,
            };
            if mine {
                own.push(notice);
            } else {
                keep.push_back(notice);
            }
        }
        *queue = keep;
        own
    }

    #[test]
    fn notices_drain_once_and_merge_by_run() {
        let _guard = serial();
        let distro = "Ubuntu-merge";
        take_own(distro);
        record_unproven(distro, "run-1");
        record_unproven(distro, "run-1");
        record_unproven(distro, "run-2");
        let taken = take_own(distro);
        assert_eq!(taken.len(), 2);
        assert!(take_own(distro).is_empty());
    }

    #[test]
    fn queue_is_bounded() {
        let _guard = serial();
        let distro = "Ubuntu-bounded";
        take_own(distro);
        for i in 0..(MAX_NOTICES + 5) {
            record_unproven(distro, &format!("run-{i}"));
        }
        let taken = take_own(distro);
        assert_eq!(taken.len(), MAX_NOTICES);
        // 最旧的被挤掉,最新的保留
        assert!(matches!(
            taken.last(),
            Some(WslNotice::ExitUnproven { run_id, .. }) if run_id == &format!("run-{}", MAX_NOTICES + 4)
        ));
    }

    /// rg 缺失是每发行版一条的持久状态,不能因为输入 `@` 次数多而刷屏,
    /// 也不能把同发行版的"未确认退出"合并掉(两者是不同事件)。
    #[test]
    fn rg_missing_merges_per_distro_and_keeps_other_kinds() {
        let _guard = serial();
        let distro = "Ubuntu-rg";
        take_own(distro);
        record_unproven(distro, "run-x");
        record_rg_missing(distro);
        record_rg_missing(distro);
        let taken = take_own(distro);
        assert_eq!(taken.len(), 2);
        assert!(matches!(taken[0], WslNotice::ExitUnproven { .. }));
        assert!(matches!(taken[1], WslNotice::RgMissing { .. }));
    }
}
