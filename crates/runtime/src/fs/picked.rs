use super::FsError;
use super::path::NodePath;
use super::workspace::{ChildKind, Contents, FinderRoot, WorkspaceFs, WriteOptions};
use crate::failure::{Errno, Failure, Outcome};
use crate::sync::Locked;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct PickedFolders {
    roots: Arc<Mutex<Vec<FinderRoot>>>,
}

type Picked<T> = std::result::Result<T, FsError>;

impl PickedFolders {
    pub fn add(&self, path: &str) -> Picked<String> {
        if !path.is_absolute() {
            return Err(Failure::invalid("a picked folder is an absolute path").into());
        }
        let path = match path.normalize() {
            clean if clean.len() > 1 => clean.trim_end_matches('/').to_owned(),
            clean => clean,
        };
        if !Path::new(&path).is_dir() {
            return Err(Failure::invalid("a picked folder must be an existing folder").into());
        }
        let mut roots = self.roots.locked();
        if !roots.iter().any(|root| root.path == path) {
            roots.push(WorkspaceFs::granted(&path));
        }
        Ok(path)
    }

    fn locate(&self, path: &str) -> Outcome<(FinderRoot, String)> {
        let roots = self.roots.locked();
        let within = |root: &FinderRoot| -> Option<String> {
            if root.path == path {
                return Some(String::new());
            }
            let rest = if root.path == "/" { path.strip_prefix('/') } else { path.strip_prefix(root.path.as_str())?.strip_prefix('/') };
            rest.map(str::to_owned)
        };
        roots
            .iter()
            .filter_map(|root| within(root).map(|relative| (root.clone(), relative)))
            .max_by_key(|(root, _)| root.path.len())
            .ok_or_else(|| Failure::http(403, "not inside a folder the user picked"))
    }

    pub fn entries(&self, dir: &str) -> Picked<Vec<(String, ChildKind)>> {
        let (root, relative) = self.locate(dir)?;
        Ok(WorkspaceFs::children_in(&root, &relative)?)
    }

    pub fn child(&self, dir: &str, name: &str, create: Option<ChildKind>) -> Picked<Option<ChildKind>> {
        let (root, relative) = self.locate(dir)?;
        Ok(WorkspaceFs::child_in(&root, &relative, name, create)?)
    }

    pub fn remove(&self, dir: &str, name: &str, recursive: bool) -> Picked<bool> {
        let (root, relative) = self.locate(dir)?;
        Ok(WorkspaceFs::remove_child_in(&root, &relative, name, recursive)?)
    }

    pub fn read(&self, path: &str) -> Picked<Option<Contents>> {
        let (root, relative) = self.locate(path)?;
        match WorkspaceFs::read_bytes_in(&root, &relative) {
            Ok(contents) => Ok(Some(contents)),
            Err(failure) if failure.errno == Errno::Noent => Ok(None),
            Err(failure) => Err(failure.into()),
        }
    }

    pub fn write(&self, path: &str, data: &[u8]) -> Picked<()> {
        let (root, relative) = self.locate(path)?;
        WorkspaceFs::write_file_in(&root, &relative, data, &WriteOptions::default())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn scratch() -> String {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!("acde-picked-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
        std::fs::create_dir_all(dir.join("picked")).unwrap();
        dir.to_string_lossy().into_owned()
    }

    fn code<T>(result: Picked<T>) -> &'static str {
        result.err().map_or("ok", |error| error.code)
    }

    #[test]
    fn only_inside_a_picked_folder() {
        let base = scratch();
        let picked = base.join("picked");
        let folders = PickedFolders::default();
        assert_eq!(code(folders.entries(&picked)), "EACCES");
        assert_eq!(folders.add(&format!("{picked}/")).unwrap(), picked);
        assert!(folders.entries(&picked).unwrap().is_empty());
        assert_eq!(code(folders.entries(&base)), "EACCES");
        assert_eq!(code(folders.read(&format!("{picked}x/a"))), "EACCES");
        assert_eq!(code(folders.add("relative")), "EINVAL");
        _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn children_are_created_listed_read_and_removed() {
        let base = scratch();
        let picked = base.join("picked");
        let folders = PickedFolders::default();
        folders.add(&picked).unwrap();
        assert_eq!(folders.child(&picked, "a.txt", None).unwrap(), None);
        assert_eq!(folders.child(&picked, "a.txt", Some(ChildKind::File)).unwrap(), Some(ChildKind::File));
        assert_eq!(folders.child(&picked, "sub", Some(ChildKind::Directory)).unwrap(), Some(ChildKind::Directory));
        assert_eq!(folders.child(&picked, "sub", Some(ChildKind::File)).unwrap(), Some(ChildKind::Directory));
        let sub = picked.join("sub");
        assert_eq!(folders.child(&sub, "deep", Some(ChildKind::Directory)).unwrap(), Some(ChildKind::Directory));
        folders.write(&sub.join("deep/n.md"), b"# n").unwrap();
        let read = folders.read(&sub.join("deep/n.md")).unwrap().unwrap();
        assert_eq!(read.data, b"# n");
        assert!(folders.read(&sub.join("gone.md")).unwrap().is_none());
        let mut names = folders.entries(&picked).unwrap();
        names.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(names, [("a.txt".to_string(), ChildKind::File), ("sub".to_string(), ChildKind::Directory)]);
        assert_eq!(code(folders.remove(&picked, "sub", false)), "ENOTEMPTY");
        assert!(folders.remove(&picked, "sub", true).unwrap());
        assert!(!folders.remove(&picked, "sub", true).unwrap());
        assert_eq!(code(folders.child(&picked, "..", None)), "EINVAL");
        assert_eq!(code(folders.child(&picked, "a/b", None)), "EINVAL");
        _ = std::fs::remove_dir_all(base);
    }

    #[test]
    fn links_do_not_lead_out() {
        let base = scratch();
        let picked = base.join("picked");
        let folders = PickedFolders::default();
        folders.add(&picked).unwrap();
        symlink(base.join("nowhere"), picked.join("dangling")).unwrap();
        symlink(&base, picked.join("out")).unwrap();
        assert_eq!(folders.child(&picked, "dangling", Some(ChildKind::File)).unwrap(), Some(ChildKind::Other));
        assert!(!Path::new(&base.join("nowhere")).exists());
        assert_eq!(folders.child(&picked, "out", None).unwrap(), Some(ChildKind::Other));
        assert_eq!(code(folders.entries(&picked.join("out"))), "EINVAL");
        assert_eq!(code(folders.write(&picked.join("out/x"), b"x")), "EINVAL");
        assert!(!Path::new(&base.join("x")).exists());
        _ = std::fs::remove_dir_all(base);
    }
}
