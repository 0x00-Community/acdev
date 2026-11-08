use super::*;
use std::{path::PathBuf, process::Command};

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

#[test]
fn windows_desktop_override_uses_native_paths_and_safe_fallback() {
    let s = Scratch::new();
    let home = s.path.join("profile");
    let fallback = home.join("Desktop");
    let selected = home.join("override");
    for path in [&fallback, &selected] {
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
        ("", fallback),
        ("D:relative", fallback),
        (r"\root-relative", fallback),
        ("/", fallback),
        (r"\\server", fallback),
        (r"\\.\pipe\anything", fallback),
        (r"\\?\C:\", fallback),
        ("$HOME", fallback),
    ];
    for (input, expected) in paths {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "fs::workspace::windows_tests::desktop_override_child"])
            .env("HOME", &home)
            .env("USERPROFILE", &home)
            .env("XDG_STATE_HOME", &home)
            .env("XDG_DESKTOP_DIR", input)
            .env_remove("XDG_DOWNLOAD_DIR")
            .env("ACDE_TEST_DESKTOP", expected)
            .output()
            .unwrap();
        assert!(output.status.success(), "override {input:?}: {}", String::from_utf8_lossy(&output.stdout));
    }
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
