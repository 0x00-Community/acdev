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
