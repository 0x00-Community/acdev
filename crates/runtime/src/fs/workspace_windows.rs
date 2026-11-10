use super::*;
use std::{path::PathBuf, process::Command, sync::Arc};

use crate::fs::access::grants::Grants;
use crate::fs::{FsCall, FsReply, Shared, Workspace};

struct Scratch {
    path: PathBuf,
    root: FinderRoot,
}

impl Scratch {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("acde-ws-{}", uuid::Uuid::new_v4()));
        let root = path.join("root");
        fs::create_dir_all(&root).unwrap();
        Self { path, root: WorkspaceFs::granted(root.to_str().unwrap()) }
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir(Path::new(&self.root.path).join("out"));
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn invalid<T>(result: Outcome<T>) {
    assert!(matches!(result, Err(Failure { errno: Errno::Inval, .. })));
}

#[test]
fn native_descendants_can_be_listed_read_and_written() {
    let s = Scratch::new();
    let root = Path::new(&s.root.path);
    fs::create_dir(root.join("notes")).unwrap();
    fs::write(root.join("notes/source.txt"), "test").unwrap();
    assert_eq!(WorkspaceFs::read_text_in(&s.root, "notes/./source.txt").unwrap().0, "test");
    let listing = WorkspaceFs::new().list_in(s.root.clone(), "notes", false).unwrap();
    assert_eq!(listing.entries[0].name, "source.txt");
    WorkspaceFs::write_file_in(&s.root, "notes/new.txt", b"created", &WriteOptions::default()).unwrap();
    assert_eq!(fs::read(root.join("notes/new.txt")).unwrap(), b"created");
}

#[test]
fn relative_names_cannot_address_windows_namespaces_or_escape() {
    let s = Scratch::new();
    let rooted_or_traversal = ["../secret", "..\\secret", "C:note.txt", "C:/note.txt", "\\note.txt", "dir/.. /file"];
    let special_names = ["file.txt:stream", "NUL.txt", "COM¹.txt"];
    for path in rooted_or_traversal.into_iter().chain(special_names) {
        invalid(WorkspaceFs::write_file_in(&s.root, path, b"test", &WriteOptions::default()));
    }
    assert_eq!(fs::read_dir(&s.root.path).unwrap().count(), 0);
}

#[test]
fn junction_cannot_escape_on_read_or_recursive_create() {
    let s = Scratch::new();
    let outside = s.path.join("root-sibling");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside").unwrap();
    let create_junction = "New-Item -ItemType Junction -Path $env:ACDE_TEST_JUNCTION \
        -Target $env:ACDE_TEST_TARGET -ErrorAction Stop | Out-Null";
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(create_junction)
        .env("ACDE_TEST_JUNCTION", Path::new(&s.root.path).join("out"))
        .env("ACDE_TEST_TARGET", &outside)
        .status()
        .unwrap();
    assert!(status.success());
    invalid(WorkspaceFs::read_text_in(&s.root, "out/secret.txt"));
    invalid(WorkspaceFs::write_file_in(&s.root, "out/secret.txt", b"changed", &WriteOptions::default()));
    invalid(WorkspaceFs::mkdir_in(&s.root, "out/escaped", &MkdirOptions { recursive: true }));
    assert!(!outside.join("escaped").exists());
    assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside");
}

struct Denied(Vec<PathBuf>);

impl Denied {
    fn add(&mut self, path: PathBuf, rights: &str) {
        let status = Command::new("icacls").arg(&path).arg("/deny").arg(format!("*S-1-1-0:{rights}")).arg("/Q").status().unwrap();
        assert!(status.success(), "icacls /deny {rights} on {}", path.display());
        self.0.push(path);
    }
}

impl Drop for Denied {
    fn drop(&mut self) {
        for path in &self.0 {
            _ = Command::new("icacls").arg(path).args(["/remove:d", "*S-1-1-0", "/Q"]).status();
        }
    }
}

fn answer<T>(outcome: Outcome<T>) -> (u16, &'static str) {
    match outcome {
        Ok(_) => (0, "ok"),
        Err(failure) => (failure.status, failure.errno.as_str()),
    }
}

#[test]
fn writes_the_system_denies_answer_403() {
    let s = Scratch::new();
    let root = Path::new(&s.root.path);
    for dir in ["no-add", "sealed", "kept"] {
        fs::create_dir(root.join(dir)).unwrap();
    }
    fs::write(root.join("a.txt"), "a").unwrap();
    fs::write(root.join("kept/keep.txt"), "keep").unwrap();
    let mut denied = Denied(Vec::new());
    denied.add(root.join("no-add"), "(WD,AD)");
    denied.add(root.join("sealed"), "(W)");
    denied.add(root.join("kept"), "(DC)");
    denied.add(root.join("kept/keep.txt"), "(DE)");
    let recursive = MkdirOptions { recursive: true };
    for dir in ["no-add", "sealed"] {
        let at = |name: &str| format!("{dir}/{name}");
        assert_eq!(answer(WorkspaceFs::write_file_in(&s.root, &at("new.txt"), b"x", &WriteOptions::default())), (403, "EACCES"), "{dir}");
        assert_eq!(answer(WorkspaceFs::write_in(&s.root, &at("new.txt"), "x", "new")), (403, "EACCES"), "{dir}");
        assert_eq!(answer(WorkspaceFs::mkdir_in(&s.root, &at("sub"), &MkdirOptions::default())), (403, "EACCES"), "{dir}");
        assert_eq!(answer(WorkspaceFs::mkdir_in(&s.root, &at("sub/deeper"), &recursive)), (403, "EACCES"), "{dir}");
        assert_eq!(answer(WorkspaceFs::child_in(&s.root, dir, "made", Some(EntryKind::File))), (403, "EACCES"), "{dir}");
        assert_eq!(answer(WorkspaceFs::rename_in(&s.root, "a.txt", &at("a.txt"))), (403, "EACCES"), "{dir}");
        assert_eq!(answer(crate::fs::copy::copy(&s.root, "a.txt", &s.root, dir)), (403, "EACCES"), "{dir}");
    }
    assert_eq!(answer(WorkspaceFs::remove_in(&s.root, "kept/keep.txt")), (403, "EACCES"));
    assert_eq!(answer(WorkspaceFs::remove_child_in(&s.root, "kept", "keep.txt", false)), (403, "EACCES"));
    assert_eq!(answer(WorkspaceFs::new().list_in(s.root.clone(), "sealed", true)), (403, "EACCES"));
    drop(denied);
    assert_eq!(fs::read(root.join("kept/keep.txt")).unwrap(), b"keep");
    assert_eq!(fs::read(root.join("a.txt")).unwrap(), b"a");
    for dir in ["no-add", "sealed"] {
        assert_eq!(fs::read_dir(root.join(dir)).unwrap().count(), 0, "{dir}");
    }
}

#[test]
fn a_missing_parent_still_answers_einval() {
    let s = Scratch::new();
    assert_eq!(answer(WorkspaceFs::write_file_in(&s.root, "missing/new.txt", b"x", &WriteOptions::default())), (400, "EINVAL"));
    assert_eq!(answer(WorkspaceFs::mkdir_in(&s.root, "missing/sub", &MkdirOptions::default())), (400, "EINVAL"));
    assert_eq!(answer(WorkspaceFs::remove_in(&s.root, "missing.txt")), (404, "ENOENT"));
}

fn desktop_child(home: &Path, known: &Path, desktop: Option<&str>, expected: &str) {
    let mut child = Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", "fs::workspace::windows_tests::desktop_override_child"])
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env("XDG_STATE_HOME", home)
        .env("ACDE_TEST_KNOWN_DESKTOP", known)
        .env_remove("XDG_DOWNLOAD_DIR")
        .env("ACDE_TEST_DESKTOP", expected);
    match desktop {
        Some(input) => child.env("XDG_DESKTOP_DIR", input),
        None => child.env_remove("XDG_DESKTOP_DIR"),
    };
    let output = child.output().unwrap();
    assert!(output.status.success(), "override {desktop:?}: {}", String::from_utf8_lossy(&output.stdout));
}

#[test]
fn windows_desktop_override_uses_native_paths_and_safe_fallback() {
    let s = Scratch::new();
    let home = s.path.join("profile");
    let fallback = home.join("Desktop");
    let selected = home.join("override");
    let known = s.path.join("known");
    for path in [&fallback, &selected, &known] {
        fs::create_dir_all(path).unwrap();
        fs::write(path.join("fixture.txt"), "isolated desktop").unwrap();
    }
    let selected = selected.to_str().unwrap();
    let forward_slash = selected.replace('\\', "/");
    let fallback = fallback.to_str().unwrap();
    let paths = [
        (selected, selected),
        (&forward_slash, selected),
        ("$HOME/override", selected),
        (r"$HOME\override", selected),
        ("", known.to_str().unwrap()),
        ("D:relative", fallback),
        (r"\root-relative", fallback),
        ("/", fallback),
        (r"\\server", fallback),
        (r"\\.\pipe\anything", fallback),
        (r"\\?\C:\", fallback),
        ("$HOME", fallback),
    ];
    for (input, expected) in paths {
        desktop_child(&home, &known, Some(input), expected);
    }
}

#[test]
fn level_0_desktop_uses_the_known_folder_without_creating_the_profile_one() {
    let s = Scratch::new();
    let home = s.path.join("profile");
    let known = s.path.join("OneDrive").join("Desktop");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&known).unwrap();
    fs::write(known.join("fixture.txt"), "isolated desktop").unwrap();
    desktop_child(&home, &known, None, known.to_str().unwrap());
    assert!(!home.join("Desktop").exists());
}

#[test]
fn desktop_override_child() {
    use crate::fs::{FsCall, FsReply, Workspace};

    let Some(expected) = std::env::var_os("ACDE_TEST_DESKTOP") else { return };
    let workspace = Workspace::new();
    let FsReply::Json(roots) = workspace.call(FsCall::Roots).unwrap() else { panic!("expected roots") };
    let root = roots[0]["path"].as_str().unwrap();
    assert_eq!(Path::new(root), Path::new(&expected));
    let read = FsCall::ReadText { root: root.to_owned(), path: "fixture.txt".into() };
    let FsReply::Text { text, .. } = workspace.call(read).unwrap() else { panic!("expected desktop file") };
    assert_eq!(text, "isolated desktop");
}

#[test]
fn windows_desktop_override_distinguishes_disk_unc_and_device_paths() {
    use super::super::path::windows_directory;

    let accepted = [r"D:\", r"D:\desktop", "D:/desktop", r"\\server\share", "//server/share/desktop"];
    for input in accepted {
        assert_eq!(windows_directory(input).as_deref().map(Path::new), Some(Path::new(input)));
    }
    let rejected = [r"\\server", r"\\server\IPC$", r"\\server\pipe\desk", r"\\?\UNC\server\share"];
    for input in rejected {
        assert!(windows_directory(input).is_none(), "accepted {input:?}");
    }
}

fn copy_app(s: &Scratch, app: &str) -> Workspace {
    let all = Workspace { shared: Arc::new(Shared::with(Grants::new(None))), roots: None, owner: None, files: None };
    let scoped = all.scoped(Some(Vec::new()), Some(app));
    scoped.grant(&s.root.path).unwrap();
    scoped
}

fn copy(app: &Workspace, s: &Scratch, dir: &str, source: &str) -> Result<serde_json::Value, (u16, &'static str)> {
    match app.call(FsCall::CopyIn { root: s.root.path.clone(), dir: dir.into(), source: source.into() }) {
        Ok(FsReply::Json(value)) => Ok(value),
        Ok(_) => panic!("copyIn replied with something other than JSON"),
        Err(error) => Err((error.status, error.code)),
    }
}

fn outside_file(s: &Scratch, name: &str, text: &str) -> PathBuf {
    let dir = s.path.join("outside");
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join(name);
    fs::write(&file, text).unwrap();
    file
}

fn make_junction(link: &Path, target: &Path) {
    let create = "New-Item -ItemType Junction -Path $env:ACDE_TEST_JUNCTION \
        -Target $env:ACDE_TEST_TARGET -ErrorAction Stop | Out-Null";
    let status = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command"])
        .arg(create)
        .env("ACDE_TEST_JUNCTION", link)
        .env("ACDE_TEST_TARGET", target)
        .status()
        .unwrap();
    assert!(status.success());
}

#[test]
fn copy_in_refuses_an_outside_drive_path() {
    let s = Scratch::new();
    let secret = outside_file(&s, "secret.txt", "outside secret");
    let app = copy_app(&s, "vault");
    assert_eq!(copy(&app, &s, "", secret.to_str().unwrap()), Err((403, "EPERM")));
    assert!(!Path::new(&s.root.path).join("secret.txt").exists());
}

#[test]
fn copy_in_refuses_an_outside_file_url() {
    let s = Scratch::new();
    let secret = outside_file(&s, "secret.txt", "outside secret");
    let uri = url::Url::from_file_path(&secret).unwrap();
    let app = copy_app(&s, "vault");
    assert_eq!(copy(&app, &s, "", uri.as_str()), Err((403, "EPERM")));
    assert!(!Path::new(&s.root.path).join("secret.txt").exists());
}

#[test]
fn copy_in_refuses_a_junction_that_leaves_the_granted_folder() {
    let s = Scratch::new();
    let outside = s.path.join("root-sibling");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "outside").unwrap();
    let link = Path::new(&s.root.path).join("out");
    make_junction(&link, &outside);
    let app = copy_app(&s, "vault");
    let through = link.join("secret.txt");
    assert_eq!(copy(&app, &s, "", through.to_str().unwrap()), Err((403, "EPERM")));
    assert!(!Path::new(&s.root.path).join("secret.txt").exists());
    assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside");
}

#[test]
fn copy_in_accepts_a_source_inside_a_granted_folder() {
    let s = Scratch::new();
    let root = Path::new(&s.root.path);
    fs::create_dir(root.join("notes")).unwrap();
    fs::create_dir(root.join("docs")).unwrap();
    fs::write(root.join("notes/source.txt"), "inside").unwrap();
    let app = copy_app(&s, "vault");
    copy(&app, &s, "docs", root.join("notes/source.txt").to_str().unwrap()).unwrap();
    let uri = url::Url::from_file_path(root.join("notes/source.txt")).unwrap();
    let copied = copy(&app, &s, "docs", uri.as_str()).unwrap();
    assert_eq!(copied["name"], "source 2.txt");
    assert_eq!(fs::read(root.join("docs/source.txt")).unwrap(), b"inside");
    assert_eq!(fs::read(root.join("docs/source 2.txt")).unwrap(), b"inside");
}

#[test]
fn a_dropped_file_is_copied_once_for_the_app_it_was_dropped_on() {
    let s = Scratch::new();
    let dropped = outside_file(&s, "dropped.txt", "dropped contents");
    fs::create_dir(Path::new(&s.root.path).join("docs")).unwrap();
    let app = copy_app(&s, "vault");
    acde_model::drop_grant::record(Some("vault"), std::slice::from_ref(&dropped));
    let copied = copy(&app, &s, "docs", dropped.to_str().unwrap()).unwrap();
    assert_eq!(copied["name"], "dropped.txt");
    assert_eq!(fs::read(Path::new(&s.root.path).join("docs/dropped.txt")).unwrap(), b"dropped contents");
    assert_eq!(copy(&app, &s, "docs", dropped.to_str().unwrap()), Err((403, "EPERM")));
}

#[test]
fn a_dropped_file_survives_a_failed_copy() {
    let s = Scratch::new();
    let dropped = outside_file(&s, "retry.txt", "retry contents");
    fs::create_dir(Path::new(&s.root.path).join("docs")).unwrap();
    let app = copy_app(&s, "vault");
    acde_model::drop_grant::record(Some("vault"), std::slice::from_ref(&dropped));
    assert!(copy(&app, &s, "missing", dropped.to_str().unwrap()).is_err());
    assert!(copy(&app, &s, "docs", dropped.to_str().unwrap()).is_ok());
}

#[test]
fn a_drop_for_another_app_does_not_open_the_source() {
    let s = Scratch::new();
    let dropped = outside_file(&s, "other.txt", "other contents");
    let app = copy_app(&s, "vault");
    acde_model::drop_grant::record(Some("other"), std::slice::from_ref(&dropped));
    assert_eq!(copy(&app, &s, "", dropped.to_str().unwrap()), Err((403, "EPERM")));
}
