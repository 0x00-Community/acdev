use std::path::PathBuf;

use acde_hostwin::{OpenRequest, SaveRequest};

fn text(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

fn texts(paths: Vec<PathBuf>) -> Vec<String> {
    paths.into_iter().map(text).collect()
}

fn portal() -> bool {
    cfg!(target_os = "linux") && !acde_hostwin::headless()
}

pub fn folder(title: &str) -> Result<Option<String>, String> {
    if let Some(answer) = acde_hostwin::preset_folder() {
        log::info!("choose folder {title:?}: using the preset answer {answer:?}");
        return Ok(answer.map(text));
    }
    if portal() {
        return acde::Portal.choose_folder(title);
    }
    acde_hostwin::choose_folder(title).map(|picked| picked.map(text))
}

pub fn open(request: OpenRequest) -> Result<Option<Vec<String>>, String> {
    if let Some(answer) = acde_hostwin::preset_open() {
        log::info!("open {:?}: using the preset answer {answer:?}", request.title);
        if let Some(paths) = &answer
            && paths.len() > 1
            && !request.multiple
        {
            return Err(format!("the preset answer has {} files but this chooser takes one", paths.len()));
        }
        return Ok(answer.map(texts));
    }
    if portal() {
        return acde::Portal.open_files(request);
    }
    acde_hostwin::open_files(request).map(|picked| picked.map(texts))
}

pub fn save(request: SaveRequest) -> Result<Option<String>, String> {
    if let Some(answer) = acde_hostwin::preset_save() {
        log::info!("save {:?}: using the preset answer {answer:?}", request.title);
        return Ok(answer.map(text));
    }
    if portal() {
        return acde::Portal.save_file(request);
    }
    acde_hostwin::save_file(request).map(|picked| picked.map(text))
}
