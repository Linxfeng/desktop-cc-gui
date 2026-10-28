//! Git-ignore state for one file tree listing (the tree draws ignored
//! entries faded, or hides them when 设置 → 通用 → 行为 asks it to).
//!
//! libgit2 supplies git's own rules: every `.gitignore` from the work tree
//! root down, `.git/info/exclude`, `core.excludesFile`, negations, and its
//! built-in rule for `.git` itself; a path under an ignored directory is
//! ignored too. On top of the rules, as git does:
//! - tracked content is never ignored (`git add -f dist/index.js`), and a
//!   directory holding tracked content is not ignored either;
//! - a nested repository root is not ignored — the tree treats nested
//!   repositories as first-class (badge, repository selection);
//! - everything inside a `.git` directory is (its `worktrees/<name>` and
//!   `modules/<name>` open as repositories of their own).
//!
//! The tree root bounds the inheritance: a workspace that itself sits in an
//! ignored directory of an enclosing repository (`~/proj/tmp/x` with `tmp/`
//! ignored, a home-directory repository ignoring `*`) marks nothing, rather
//! than fading or hiding the whole workspace.

use git2::{Index, Repository};
use std::cell::OnceCell;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// Names among `dir`'s direct children (`(name, is_dir)`) that Git ignores,
/// for a file tree rooted at `tree_root`. Outside any work tree nothing is.
pub(crate) fn ignored_names<'a>(
    dir: &Path,
    tree_root: &Path,
    children: impl IntoIterator<Item = (&'a str, bool)>,
) -> HashSet<String> {
    let (Ok(listed), Ok(root)) = (std::fs::canonicalize(dir), std::fs::canonicalize(tree_root))
    else {
        return HashSet::new();
    };
    let children = children.into_iter();
    if inside_git_dir(&listed, &root) {
        return children.map(|(name, _)| name.to_string()).collect();
    }
    let Some(level) = Level::open(listed) else {
        return HashSet::new();
    };
    if level.root_ignored(&root) {
        return HashSet::new();
    }
    // One check settles a listing inside an ignored directory (with nothing
    // tracked under it): `node_modules/` sized levels skip the per-entry walk.
    let all_ignored = !level.prefix.is_empty() && level.ignored(&level.prefix, true);
    children
        .filter(|&(name, is_dir)| {
            if name == ".git" {
                return true;
            }
            let ignored = all_ignored || level.ignored(&join(&level.prefix, name), is_dir);
            ignored && !(is_dir && level.dir.join(name).join(".git").exists())
        })
        .map(|(name, _)| name.to_string())
        .collect()
}

/// `dir` lies inside a `.git` directory somewhere below the tree root.
fn inside_git_dir(dir: &Path, root: &Path) -> bool {
    dir.strip_prefix(root)
        .is_ok_and(|rel| rel.components().any(|c| c.as_os_str() == ".git"))
}

/// One listed directory and the repository whose work tree holds it.
struct Level {
    repo: Repository,
    workdir: PathBuf,
    /// The listed directory, canonical.
    dir: PathBuf,
    /// `dir` relative to the work tree: "" at its root, `/`-separated.
    prefix: String,
    /// Opened on the first rule hit; most entries never need it.
    index: OnceCell<Option<Index>>,
}

impl Level {
    fn open(dir: PathBuf) -> Option<Self> {
        let repo = Repository::discover(&dir).ok()?;
        let workdir = std::fs::canonicalize(repo.workdir()?).ok()?;
        let prefix = slash_path(dir.strip_prefix(&workdir).ok()?);
        Some(Self {
            repo,
            workdir,
            dir,
            prefix,
            index: OnceCell::new(),
        })
    }

    /// The tree root sits strictly inside this work tree and is ignored.
    fn root_ignored(&self, root: &Path) -> bool {
        root.strip_prefix(&self.workdir)
            .map(slash_path)
            .is_ok_and(|rel| !rel.is_empty() && self.ignored(&rel, true))
    }

    /// Git's verdict for a work-tree path: a rule matches and nothing
    /// tracked keeps it.
    fn ignored(&self, rel: &str, is_dir: bool) -> bool {
        matches_rule(&self.repo, rel, is_dir) && !self.tracked(rel, is_dir)
    }

    /// `rel` is in the index (a directory: something under it is).
    fn tracked(&self, rel: &str, is_dir: bool) -> bool {
        let Some(index) = self.index.get_or_init(|| self.repo.index().ok()) else {
            return false;
        };
        if is_dir {
            return index.find_prefix(format!("{rel}/")).is_ok();
        }
        // Index paths sort bytewise, so an exact entry precedes every longer
        // path sharing its prefix (`app.log` < `app.log.d/x`).
        index
            .find_prefix(rel)
            .ok()
            .and_then(|position| index.get(position))
            .is_some_and(|entry| entry.path == rel.as_bytes())
    }
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn join(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}/{name}")
    }
}

fn matches_rule(repo: &Repository, rel: &str, is_dir: bool) -> bool {
    // A trailing slash tells libgit2 the path is a directory, so dir-only
    // patterns (`build/`) match without it stat-ing the entry again.
    let path = if is_dir {
        format!("{rel}/")
    } else {
        rel.to_string()
    };
    repo.is_path_ignored(Path::new(&path)).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Scratch(PathBuf);

    impl Scratch {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("ccgui-next-git-ignore-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn dir(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        fn file(&self, rel: &str, body: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Children of `dir` as the tree lists them: `(name, is_dir)`.
    fn listing(dir: &Path) -> Vec<(String, bool)> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| {
                let is_dir = entry.file_type().unwrap().is_dir();
                (entry.file_name().to_string_lossy().into_owned(), is_dir)
            })
            .collect()
    }

    /// Ignored children of `dir` in a tree rooted at `tree_root`, sorted.
    fn ignored_in_tree(dir: &Path, tree_root: &Path) -> Vec<String> {
        let children = listing(dir);
        let mut names: Vec<String> = ignored_names(
            dir,
            tree_root,
            children
                .iter()
                .map(|(name, is_dir)| (name.as_str(), *is_dir)),
        )
        .into_iter()
        .collect();
        names.sort();
        names
    }

    /// Same, for a tree rooted at the repository that holds `dir`'s scratch
    /// (`dir` itself or an ancestor named `ccgui-next-git-ignore-*`).
    fn ignored_in(dir: &Path) -> Vec<String> {
        let root = dir
            .ancestors()
            .find(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("ccgui-next-git-ignore-"))
            })
            .unwrap();
        ignored_in_tree(dir, root)
    }

    /// Stage `rel` in the repository at `root` (`git add -f`: rules skipped).
    fn force_add(root: &Path, rel: &str) {
        let repo = Repository::open(root).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(rel)).unwrap();
        index.write().unwrap();
    }

    fn repo_with_ignores() -> Scratch {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", ".idea/\n*.log\n!keep.log\nbuild/\n");
        scratch.file("src/main.py", "");
        scratch.file("src/cache.log", "");
        scratch.file(".idea/workspace.xml", "");
        scratch.file("build/out/app.bin", "");
        scratch.file("debug.log", "");
        scratch.file("keep.log", "");
        scratch.file("README.md", "");
        scratch
    }

    #[test]
    fn root_listing_marks_gitignored_entries_and_the_git_dir() {
        let scratch = repo_with_ignores();
        assert_eq!(
            ignored_in(&scratch.0),
            [".git", ".idea", "build", "debug.log"],
            "negated keep.log, .gitignore, src and README.md stay visible"
        );
    }

    #[test]
    fn nested_listing_applies_root_patterns() {
        let scratch = repo_with_ignores();
        assert_eq!(ignored_in(&scratch.0.join("src")), ["cache.log"]);
    }

    #[test]
    fn listing_inside_an_ignored_directory_marks_every_child() {
        let scratch = repo_with_ignores();
        assert_eq!(ignored_in(&scratch.0.join("build")), ["out"]);
        assert_eq!(ignored_in(&scratch.0.join("build/out")), ["app.bin"]);
    }

    #[test]
    fn listing_inside_the_git_dir_marks_every_child() {
        let scratch = repo_with_ignores();
        let git_dir = scratch.0.join(".git");
        let children = listing(&git_dir);
        assert!(!children.is_empty());
        assert_eq!(ignored_in(&git_dir).len(), children.len());
    }

    #[test]
    fn info_exclude_counts_as_ignored() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".git/info/exclude", "scratch.txt\n");
        scratch.file("scratch.txt", "");
        scratch.file("kept.txt", "");
        assert_eq!(ignored_in(&scratch.0), [".git", "scratch.txt"]);
    }

    #[test]
    fn dir_only_pattern_leaves_a_same_named_file_alone() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", "out/\n");
        scratch.file("pkg/out", "");
        scratch.dir("out");
        assert_eq!(ignored_in(&scratch.0), [".git", "out"]);
        assert!(ignored_in(&scratch.0.join("pkg")).is_empty());
    }

    #[test]
    fn nested_repository_uses_its_own_rules() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", "*.tmp\n");
        let nested = scratch.dir("vendor/lib");
        Repository::init(&nested).unwrap();
        scratch.file("vendor/lib/.gitignore", "dist/\n");
        scratch.file("vendor/lib/dist/x.js", "");
        scratch.file("vendor/lib/a.tmp", "");
        assert_eq!(ignored_in(&nested), [".git", "dist"]);
    }

    #[test]
    fn outside_a_repository_nothing_is_ignored() {
        let scratch = Scratch::new();
        scratch.file(".gitignore", "*.log\n");
        scratch.file("debug.log", "");
        assert!(ignored_in(&scratch.0).is_empty());
    }

    #[test]
    fn tracked_files_are_not_ignored_even_when_a_rule_matches() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", "dist/\n*.log\n");
        scratch.file("fixture.log", "");
        scratch.file("debug.log", "");
        scratch.file("dist/index.js", "");
        scratch.file("dist/chunk.js", "");
        scratch.file("app.log", "");
        scratch.file("app.log.d/keep.txt", "");
        force_add(&scratch.0, "fixture.log");
        force_add(&scratch.0, "dist/index.js");
        force_add(&scratch.0, "app.log.d/keep.txt");
        // `dist/` holds tracked content, so it stays; only the untracked rule
        // hits are ignored — `app.log` too, although the tracked
        // `app.log.d/keep.txt` shares its name as a prefix.
        assert_eq!(ignored_in(&scratch.0), [".git", "app.log", "debug.log"]);
        assert_eq!(ignored_in(&scratch.0.join("dist")), ["chunk.js"]);
    }

    #[test]
    fn nested_repository_root_ignored_by_the_outer_repo_stays_unmarked() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", "inner/\nvendor/\n");
        Repository::init(scratch.dir("inner")).unwrap();
        Repository::init(scratch.dir("vendor/lib")).unwrap();
        scratch.file("vendor/notes.txt", "");
        assert_eq!(ignored_in(&scratch.0), [".git", "vendor"]);
        // Inside an ignored directory the nested repository still stands out.
        assert_eq!(ignored_in(&scratch.0.join("vendor")), ["notes.txt"]);
    }

    #[test]
    fn tree_rooted_inside_an_ignored_directory_marks_nothing() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        scratch.file(".gitignore", "tmp/\n*.log\n");
        scratch.file("tmp/experiment/main.py", "");
        scratch.file("tmp/experiment/run.log", "");
        let workspace = scratch.0.join("tmp/experiment");
        assert!(ignored_in_tree(&workspace, &workspace).is_empty());
        // The same folder seen from a tree rooted at the repository is
        // ignored territory.
        assert_eq!(ignored_in(&workspace), ["main.py", "run.log"]);
    }

    #[test]
    fn git_internals_that_open_as_repositories_are_still_ignored() {
        let scratch = Scratch::new();
        Repository::init(&scratch.0).unwrap();
        let module = scratch.0.join(".git/modules/sub");
        Repository::init_bare(&module).unwrap();
        let children = listing(&module);
        assert!(!children.is_empty());
        assert_eq!(ignored_in(&module).len(), children.len());
    }
}
