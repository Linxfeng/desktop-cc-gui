//! "在浏览器中打开" for local HTML files (file tree and changes panel menus).
//!
//! The file goes to the user's default *web browser*, not to the default app
//! for `.html`: on developer machines that type is often claimed by an editor
//! (VS Code, Xcode), and "open in browser" opening an editor would be a lie.

use std::path::{Path, PathBuf};

use super::expand_user_path;

/// Mirrors `isHtmlFile` in src/features/files/editor-view-mode.ts. The gate
/// also keeps this command from becoming a generic "launch this file"
/// primitive: the fallback hands the path to the OS default handler, which
/// for `.command` / `.app` / `.exe` would execute it.
const HTML_EXTENSIONS: [&str; 3] = ["html", "htm", "xhtml"];

fn is_html_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            HTML_EXTENSIONS
                .iter()
                .any(|allowed| ext.eq_ignore_ascii_case(allowed))
        })
}

/// Canonical path of an existing HTML file. The extension is checked on the
/// canonical path so a `page.html` symlink to a script is refused.
fn resolve_html_file(path: &str) -> Result<PathBuf, String> {
    let expanded = expand_user_path(path)?;
    let canonical = dunce::canonicalize(&expanded)
        .map_err(|error| format!("Failed to resolve path `{path}`: {error}"))?;
    if !canonical.is_file() {
        return Err(format!("Not a file: `{path}`"));
    }
    if !is_html_path(&canonical) {
        return Err(format!("Not an HTML file: `{path}`"));
    }
    Ok(canonical)
}

/// Bundle of the app that opens `https://` links — the default browser.
#[cfg(target_os = "macos")]
fn default_browser_app() -> Option<PathBuf> {
    use objc2_app_kit::NSWorkspace;
    use objc2_foundation::{NSString, NSURL};

    let probe = NSURL::URLWithString(&NSString::from_str("https://example.com"))?;
    NSWorkspace::sharedWorkspace()
        .URLForApplicationToOpenURL(&probe)?
        .to_file_path()
}

/// Open a local HTML file in the default web browser.
///
/// macOS resolves the browser explicitly (`open -a <browser>`) and only falls
/// back to the file's default handler when no browser is registered. Windows
/// and Linux use the default handler for `.html`, which there is the browser
/// unless the user rebound it.
#[tauri::command]
pub(crate) async fn open_in_browser(path: String) -> Result<(), String> {
    let file = resolve_html_file(&path)?;

    #[cfg(target_os = "macos")]
    {
        let mut command = tokio::process::Command::new("open");
        if let Some(browser) = default_browser_app() {
            command.arg("-a").arg(browser);
        }
        let status = command
            .arg(&file)
            .status()
            .await
            .map_err(|error| format!("Failed to open browser: {error}"))?;
        if status.success() {
            return Ok(());
        }
        return Err(format!(
            "Failed to open browser ({}).",
            super::format_exit_detail(status.code())
        ));
    }

    #[cfg(not(target_os = "macos"))]
    {
        tauri_plugin_opener::open_path(&file, None::<&str>)
            .map_err(|error| format!("Failed to open browser: {error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir()
                .join(format!("ccgui-next-open-browser-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn file(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            std::fs::write(&path, "<!doctype html>").unwrap();
            path
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn html_extensions_match_case_insensitively() {
        for name in ["a.html", "a.htm", "a.xhtml", "A.HTML", "设计 稿.Htm"] {
            assert!(is_html_path(Path::new(name)), "{name}");
        }
        for name in ["a.md", "a.html.txt", "html", "a.command", "a.shtml"] {
            assert!(!is_html_path(Path::new(name)), "{name}");
        }
    }

    #[test]
    fn resolves_an_existing_html_file() {
        let scratch = Scratch::new();
        let file = scratch.file("pr flow-design.html");
        let resolved = resolve_html_file(&file.to_string_lossy()).unwrap();
        assert_eq!(resolved, dunce::canonicalize(&file).unwrap());
    }

    #[test]
    fn refuses_non_html_missing_and_directory_targets() {
        let scratch = Scratch::new();
        let script = scratch.file("run.command");
        assert!(resolve_html_file(&script.to_string_lossy())
            .unwrap_err()
            .contains("Not an HTML file"));
        let missing = scratch.0.join("gone.html");
        assert!(resolve_html_file(&missing.to_string_lossy())
            .unwrap_err()
            .contains("Failed to resolve"));
        let dir = scratch.0.join("site.html");
        std::fs::create_dir(&dir).unwrap();
        assert!(resolve_html_file(&dir.to_string_lossy())
            .unwrap_err()
            .contains("Not a file"));
        assert!(resolve_html_file("  ").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_an_html_named_symlink_to_a_non_html_file() {
        let scratch = Scratch::new();
        let script = scratch.file("run.command");
        let link = scratch.0.join("page.html");
        std::os::unix::fs::symlink(&script, &link).unwrap();
        assert!(resolve_html_file(&link.to_string_lossy())
            .unwrap_err()
            .contains("Not an HTML file"));
    }
}
