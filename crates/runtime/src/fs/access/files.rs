use crate::failure::{Failure, Outcome};
use crate::fs::workspace::{FinderRoot, RootMode, RootSource, WorkspaceFs};
use sha2::{Digest, Sha256};
use std::path::Path;

const PLACES: [(&str, &str); 6] =
    [("desktop", "桌面"), ("documents", "文档"), ("downloads", "下载"), ("music", "音乐"), ("pictures", "图片"), ("videos", "视频")];

#[napi_derive::napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GrantedFolder {
    pub id: String,
    pub label: String,
    pub exists: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Files {
    places: Vec<&'static str>,
    paths: bool,
}

impl Files {
    pub fn new(places: &[String], paths: bool) -> Self {
        let places = PLACES.iter().map(|(name, _)| *name).filter(|name| places.iter().any(|place| place == name)).collect();
        Self { places, paths }
    }

    pub fn paths(&self) -> bool {
        self.paths
    }

    pub fn token(path: &str) -> String {
        let digest = Sha256::digest(path.as_bytes());
        let hex: String = digest.iter().take(8).map(|byte| format!("{byte:02x}")).collect();
        format!("folder-{hex}")
    }

    pub(crate) fn roots(&self, fs: &WorkspaceFs, owner: &str, granted: Vec<String>) -> Outcome<Vec<FinderRoot>> {
        let private = fs.private_dir(owner);
        std::fs::DirBuilder::new().recursive(true).create(&private)?;
        let mut roots = vec![self.root("private".into(), private, "应用数据", RootSource::Private)];
        for &(name, label) in PLACES.iter().filter(|(name, _)| self.places.contains(name)) {
            let Some(path) = fs.place_dir(name) else { continue };
            let root = self.root(name.into(), path, label, RootSource::Place);
            roots.push(FinderRoot { place: Some(name), ..Self::checked(root, "the folder does not exist") });
        }
        for path in granted {
            let label = Self::label(&path);
            let root = self.root(Self::token(&path), path, &label, RootSource::Granted);
            roots.push(Self::checked(root, "the folder no longer exists"));
        }
        Ok(roots)
    }

    pub fn folder(path: &str) -> GrantedFolder {
        GrantedFolder { id: Self::token(path), label: Self::label(path), exists: Path::new(path).is_dir() }
    }

    fn label(path: &str) -> String {
        Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or("folder").to_owned()
    }

    pub(crate) fn find(roots: Vec<FinderRoot>, id: &str) -> Outcome<FinderRoot> {
        roots.into_iter().find(|root| root.id == id).ok_or_else(|| Failure::http(403, format!("this app may not use the files of {id} (not one of its roots)")))
    }

    fn root(&self, id: String, path: String, label: &str, source: RootSource) -> FinderRoot {
        let shown = self.paths.then(|| path.clone());
        FinderRoot { id, shown, ..FinderRoot::new(path, label, source) }
    }

    fn checked(root: FinderRoot, missing: &str) -> FinderRoot {
        let exists = Path::new(&root.path).is_dir();
        FinderRoot { mode: if exists { RootMode::Writable } else { RootMode::Unavailable }, reason: (!exists).then(|| missing.to_owned()), exists, ..root }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::{FsCall, FsReply, Workspace};
    use serde_json::{Value, json};

    struct Home(std::path::PathBuf);

    impl Home {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("acde-files-{name}-{}", std::process::id()));
            _ = std::fs::remove_dir_all(&dir);
            for place in ["Desktop", "Documents", "Downloads", "Music", "Pictures", "Videos"] {
                std::fs::create_dir_all(dir.join(place)).unwrap();
            }
            Self(dir)
        }

        fn text(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for Home {
        fn drop(&mut self) {
            _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn json(reply: std::result::Result<FsReply, crate::fs::FsError>) -> Value {
        match reply {
            Ok(FsReply::Json(value)) => value,
            Ok(FsReply::Text { text, .. }) => Value::String(text),
            Ok(_) => Value::String("other".into()),
            Err(error) => json!({"status": error.status, "code": error.code, "message": error.message}),
        }
    }

    fn write(workspace: &Workspace, root: &str, path: &str, text: &str) -> Value {
        let call = FsCall::WriteFile { root: root.into(), path: path.into(), data: Some(text.as_bytes().to_vec()), options: None };
        json(workspace.call(call))
    }

    fn read(workspace: &Workspace, root: &str, path: &str) -> Value {
        json(workspace.call(FsCall::ReadText { root: root.into(), path: path.into() }))
    }

    #[test]
    fn fs_true_gives_a_private_folder_and_no_shared_place() {
        let home = Home::new("private");
        let all = Workspace::at(&home.text());
        let app = all.files(Files::new(&[], false), "notes");
        let roots = json(app.call(FsCall::Roots));
        assert_eq!(roots, json!([{"id": "private", "label": "应用数据", "source": "private", "mode": "writable", "reason": null, "exists": true}]));
        assert_eq!(write(&app, "private", "a.txt", "mine")["name"], "a.txt");
        assert_eq!(read(&app, "private", "a.txt"), "mine");
        assert!(home.0.join("data").join("acde").join("files").join("notes").join("a.txt").is_file());
        for place in ["desktop", "documents", "downloads"] {
            assert_eq!(read(&app, place, "x.txt")["code"], "EACCES", "{place}");
        }
        let desktop = home.0.join("Desktop").to_string_lossy().into_owned();
        assert_eq!(json(app.call(FsCall::List { root: desktop, path: None, hidden: None }))["code"], "EACCES");
    }

    #[test]
    fn two_apps_have_separate_private_folders() {
        let home = Home::new("separate");
        let all = Workspace::at(&home.text());
        let one = all.files(Files::new(&[], false), "one");
        let two = all.files(Files::new(&[], false), "two");
        write(&one, "private", "note.txt", "one");
        assert_eq!(read(&two, "private", "note.txt")["code"], "ENOENT");
        write(&two, "private", "note.txt", "two");
        assert_eq!(read(&one, "private", "note.txt"), "one");
        assert_eq!(read(&two, "private", "note.txt"), "two");
    }

    #[test]
    fn a_named_place_is_reached_by_its_name_and_nothing_else() {
        let home = Home::new("place");
        std::fs::write(home.0.join("Documents").join("report.txt"), "report").unwrap();
        std::fs::write(home.0.join("Desktop").join("secret.txt"), "secret").unwrap();
        let all = Workspace::at(&home.text());
        let app = all.files(Files::new(&["documents".into(), "agentos-work".into()], false), "writer");
        let roots = json(app.call(FsCall::Roots));
        let ids: Vec<&str> = roots.as_array().unwrap().iter().map(|root| root["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["private", "documents"]);
        assert_eq!(roots[1]["place"], "documents");
        assert_eq!(roots[1]["label"], "文档");
        assert!(roots[1].get("path").is_none(), "{roots}");
        assert_eq!(read(&app, "documents", "report.txt"), "report");
        assert_eq!(write(&app, "documents", "new.txt", "new")["name"], "new.txt");
        assert!(home.0.join("Documents").join("new.txt").is_file());
        assert_eq!(read(&app, "desktop", "secret.txt")["code"], "EACCES");
        assert_eq!(read(&app, "documents", "../Desktop/secret.txt")["code"], "EINVAL");
    }

    #[test]
    fn only_system_apps_with_places_see_paths_and_path_calls() {
        let home = Home::new("paths");
        let all = Workspace::at(&home.text());
        let third = all.files(Files::new(&["documents".into()], false), "third");
        let system = all.files(Files::new(&["documents".into()], true), "files");
        let documents = home.0.join("Documents");
        let file = documents.join("a.txt");
        std::fs::write(&file, "a").unwrap();
        let roots = json(system.call(FsCall::Roots));
        assert_eq!(Path::new(roots[1]["path"].as_str().unwrap()), documents);
        assert!(roots[0]["path"].is_string());
        let locate = |workspace: &Workspace| json(workspace.call(FsCall::Locate { path: file.to_string_lossy().into_owned() }));
        assert_eq!(locate(&system), json!({"root": "documents", "path": "a.txt"}));
        assert_eq!(locate(&third)["code"], "EACCES");
        for call in [FsCall::State, FsCall::Desktop] {
            assert_eq!(json(third.call(call))["code"], "EACCES");
        }
    }

    #[test]
    fn a_picked_folder_is_a_root_token_until_it_is_revoked() {
        let home = Home::new("picked");
        let picked = home.0.join("Projects");
        std::fs::create_dir_all(&picked).unwrap();
        std::fs::write(picked.join("plan.md"), "plan").unwrap();
        let all = Workspace::at(&home.text());
        let app = all.files(Files::new(&[], false), "vault");
        let granted = app.grant(picked.to_str().unwrap()).unwrap();
        let token = Files::token(&granted);
        assert!(token.starts_with("folder-") && !token.contains("Projects"));
        let roots = json(app.call(FsCall::Roots));
        assert_eq!(roots[1], json!({"id": token, "label": "Projects", "source": "granted", "mode": "writable", "reason": null, "exists": true}));
        assert_eq!(read(&app, &token, "plan.md"), "plan");
        assert_eq!(read(&all.files(Files::new(&[], false), "other"), &token, "plan.md")["code"], "EACCES");
        assert!(matches!(app.call(FsCall::Revoke { root: token.clone() }), Ok(FsReply::Done)));
        assert_eq!(read(&app, &token, "plan.md")["code"], "EACCES");
    }
}
