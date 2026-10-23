//! 边界守卫(A5):本机 WSL 的平台细节只能出现在适配层。
//!
//! `wsl.exe` 的调用方式(`--exec`、`-d`)、UNC 主机名(`wsl.localhost` /
//! `wsl$`)一旦散落到 UI 或历史扫描等模块,行为差异就会到处冒出来:引擎
//! 特判、路径拼接、错误文案各写一套。设计稿 §5.10 因此把字面量收口到
//! 三个模块(阶段 2 再加终端与 Git 适配层),违例即红。
//!
//! 扫描的是**代码**,不是注释:注释里提到 `wsl.exe` 是在解释适配层,不构成
//! 违例。`#[cfg(test)]` 模块同样跳过 —— 测试用 UNC 字面量构造夹具是正常的,
//! 守卫生效的范围是会被编译进产物的代码。

use std::path::{Path, PathBuf};

/// 允许出现 WSL 平台字面量的文件(相对 `src-tauri/src`)。
const ALLOWED: &[&str] = &[
    "engine/wsl_transport.rs",
    "engine/wsl_path.rs",
    "engine/wsl_probe.rs",
    // 阶段 2 的适配层;文件尚不存在时自然不参与扫描。
    "terminal.rs",
    "git_wsl.rs",
];

/// 受管字面量(大小写不敏感)。
const MARKERS: &[&str] = &["wsl.exe", "wsl.localhost", "wsl$"];

#[test]
fn wsl_platform_literals_stay_in_the_adapter_layer() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    collect_rs_files(&src, &mut files);
    assert!(
        files.len() > 50,
        "扫描到的 Rust 源文件太少({}),守卫路径可能配错了",
        files.len()
    );

    let mut violations = Vec::new();
    for file in files {
        let rel = file
            .strip_prefix(&src)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if ALLOWED.contains(&rel.as_str()) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let code = strip_test_modules(&strip_comments(&text)).to_lowercase();
        for marker in MARKERS {
            if code.contains(marker) {
                violations.push(format!("{rel}: 出现 `{marker}`"));
            }
        }
    }
    assert!(
        violations.is_empty(),
        "WSL 平台字面量必须收口在 {:?} 中,以下位置越界:\n{}",
        ALLOWED,
        violations.join("\n")
    );
}

/// 守卫自身的解析必须可信:注释和测试模块里的字面量不能误报,生产代码里
/// 的则不能漏报。
#[test]
fn guard_ignores_comments_and_tests_but_catches_production_literals() {
    let sample = r#"
// 注释里的 wsl.exe 不算违例
/// 文档注释里的 \\wsl.localhost 也不算
fn run() {
    let a = "wsl.exe -d Ubuntu"; // 行尾注释
    let b = r"\\wsl$\Ubuntu\home";
    let c = 1; /* 块注释 wsl.localhost */
    let d = "plain";
}
#[cfg(test)]
mod tests {
    #[test]
    fn fixture() {
        let p = r"\\wsl.localhost\Ubuntu\home";
        assert!(p.contains("wsl$"));
    }
}
"#;
    let code = strip_test_modules(&strip_comments(sample)).to_lowercase();
    assert!(code.contains("wsl.exe"), "生产代码里的字面量必须被看到");
    assert!(code.contains("wsl$"), "原始字符串里的字面量必须被看到");
    assert!(
        !code.contains("wsl.localhost"),
        "注释与测试模块里的字面量不该进入扫描结果"
    );
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push(path);
        }
    }
}

/// 把注释替换成等量换行(保留行号语义),字符串原样保留。
///
/// 只处理 Rust 词法的必要子集:普通字符串与 `r#"…"#` 原始字符串、行注释与
/// 可嵌套块注释。字符字面量里不可能出现 `//` 或 `/*` 的组合,不做特殊处理。
fn strip_comments(src: &str) -> String {
    #[derive(Clone, Copy, PartialEq)]
    enum State {
        Code,
        Line,
        Block(usize),
        Str,
        Raw(usize),
    }

    let bytes = src.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut state = State::Code;
    let mut i = 0;
    while i < bytes.len() {
        let byte = bytes[i];
        match state {
            State::Code => {
                if byte == b'/' && bytes.get(i + 1) == Some(&b'/') {
                    state = State::Line;
                    i += 2;
                } else if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    state = State::Block(1);
                    i += 2;
                } else if byte == b'"' {
                    out.push('"');
                    state = State::Str;
                    i += 1;
                } else if byte == b'r' {
                    // r"…" / r#"…"#
                    let mut hashes = 0;
                    while bytes.get(i + 1 + hashes) == Some(&b'#') {
                        hashes += 1;
                    }
                    if bytes.get(i + 1 + hashes) == Some(&b'"') {
                        out.push_str(&src[i..i + 2 + hashes]);
                        state = State::Raw(hashes);
                        i += 2 + hashes;
                    } else {
                        out.push('r');
                        i += 1;
                    }
                } else {
                    out.push(byte as char);
                    i += 1;
                }
            }
            State::Line => {
                if byte == b'\n' {
                    out.push('\n');
                    state = State::Code;
                }
                i += 1;
            }
            State::Block(depth) => {
                if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
                    state = State::Block(depth + 1);
                    i += 2;
                } else if byte == b'*' && bytes.get(i + 1) == Some(&b'/') {
                    if depth == 1 {
                        state = State::Code;
                    } else {
                        state = State::Block(depth - 1);
                    }
                    i += 2;
                } else {
                    if byte == b'\n' {
                        out.push('\n');
                    }
                    i += 1;
                }
            }
            State::Str => {
                if byte == b'\\' {
                    out.push(byte as char);
                    if let Some(next) = bytes.get(i + 1) {
                        out.push(*next as char);
                        i += 2;
                        continue;
                    }
                } else if byte == b'"' {
                    out.push('"');
                    state = State::Code;
                } else {
                    out.push(byte as char);
                }
                i += 1;
            }
            State::Raw(hashes) => {
                if byte == b'"' {
                    let closing = (0..hashes).all(|n| bytes.get(i + 1 + n) == Some(&b'#'));
                    if closing {
                        out.push('"');
                        out.extend(std::iter::repeat('#').take(hashes));
                        state = State::Code;
                        i += 1 + hashes;
                        continue;
                    }
                }
                out.push(byte as char);
                i += 1;
            }
        }
    }
    out
}

/// 删除 `#[cfg(test)]` 起始的模块块(按大括号配平)。只跳过紧跟属性后的
/// `mod … { … }`;`#[cfg(test)]` 修饰单个函数/`use` 时按分号结束处理。
fn strip_test_modules(code: &str) -> String {
    let bytes = code.as_bytes();
    let mut out = String::with_capacity(code.len());
    let mut i = 0;
    while i < bytes.len() {
        if code[i..].starts_with("#[cfg(test)]") {
            i += "#[cfg(test)]".len();
            // 跳过属性与空白,定位条目开头。
            while i < bytes.len() && (bytes[i] as char).is_whitespace() {
                i += 1;
            }
            let rest = &code[i..];
            if rest.starts_with("mod ") || rest.starts_with("pub mod ") {
                let Some(open) = rest.find('{') else {
                    continue;
                };
                let mut depth = 0usize;
                let mut j = i + open;
                while j < bytes.len() {
                    match bytes[j] {
                        b'{' => depth += 1,
                        b'}' => {
                            depth -= 1;
                            if depth == 0 {
                                j += 1;
                                break;
                            }
                        }
                        _ => {}
                    }
                    j += 1;
                }
                // 保留换行,避免把两段代码粘在一行。
                out.extend(code[i..j].chars().filter(|c| *c == '\n'));
                i = j;
                continue;
            }
            // 非模块形态:保留属性后的条目本身,只丢属性。
            continue;
        }
        out.push(code[i..].chars().next().unwrap_or(' '));
        i += code[i..].chars().next().map(char::len_utf8).unwrap_or(1);
    }
    out
}
