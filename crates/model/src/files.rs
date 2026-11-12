#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FileFilter {
    pub name: String,
    pub globs: Vec<String>,
    pub mimes: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OpenRequest {
    pub title: String,
    pub multiple: bool,
    pub directory: bool,
    pub filters: Vec<FileFilter>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SaveRequest {
    pub title: String,
    pub name: String,
    pub filters: Vec<FileFilter>,
}
