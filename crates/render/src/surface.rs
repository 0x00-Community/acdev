use std::collections::HashMap;

pub struct DragImage {
    pub width: u32,
    pub height: u32,
    pub scene: acde_gpu::Scene,
    pub hotspot: (i32, i32),
}

pub enum SurfaceCommand {
    RequestFrame,
    SetClipboard(String),
    ReadClipboard(Box<dyn FnOnce(String) + Send>),
    StartDrag(HashMap<String, String>, Option<DragImage>),
    Mode(u32),
    GrabHint([i32; 4], u32),
    Backdrop([i32; 4], [f64; 4]),
    Activate,
    Grab(u32, bool),
    OpenPanel { id: u32, token: u64, rect: [i32; 4] },
    PlacePanel { id: u32, rect: [i32; 4], input: [i32; 4] },
    ClosePanel(u32),
    Title(String),
    ImeArea([f64; 4]),
}
