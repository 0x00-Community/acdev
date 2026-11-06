#[derive(Clone, Copy, PartialEq, Eq)]
pub enum BlankKind {
    Docx,
    Xlsx,
    Pptx,
}

impl TryFrom<&str> for BlankKind {
    type Error = ();
    fn try_from(kind: &str) -> Result<Self, ()> {
        match kind {
            "docx" => Ok(Self::Docx),
            "xlsx" => Ok(Self::Xlsx),
            "pptx" => Ok(Self::Pptx),
            _ => Err(()),
        }
    }
}

impl BlankKind {
    pub fn extension(&self) -> &str {
        match self {
            Self::Docx => "docx",
            Self::Xlsx => "xlsx",
            Self::Pptx => "pptx",
        }
    }
    pub fn default_name(&self) -> &str {
        match self {
            Self::Docx => "未命名文档",
            Self::Xlsx => "未命名表格",
            Self::Pptx => "未命名演示",
        }
    }
    pub fn create(self) -> Vec<u8> {
        match self {
            Self::Docx => include_bytes!("blank.docx").to_vec(),
            Self::Xlsx => include_bytes!("blank.xlsx").to_vec(),
            Self::Pptx => include_bytes!("blank.pptx").to_vec(),
        }
    }
}
