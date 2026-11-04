use smithay::backend::renderer::element::memory::MemoryRenderBufferRenderElement;
use smithay::backend::renderer::element::surface::WaylandSurfaceRenderElement;
use smithay::backend::renderer::element::render_elements;
use smithay::backend::renderer::element::utils::{RelocateRenderElement, RescaleRenderElement};
use smithay::backend::renderer::gles::GlesRenderer;
use smithay::desktop::space::SpaceRenderElements;
use smithay::output::Output;

render_elements! {
    pub Elements<=GlesRenderer>;
    Space=SpaceRenderElements<GlesRenderer, WaylandSurfaceRenderElement<GlesRenderer>>,
    Surface=WaylandSurfaceRenderElement<GlesRenderer>,
    Memory=MemoryRenderBufferRenderElement<GlesRenderer>,
    Moved=RelocateRenderElement<RescaleRenderElement<WaylandSurfaceRenderElement<GlesRenderer>>>,
    Backdrop=super::effects::BackdropElement,
}

pub const CLEAR: [f32; 4] = [0.08, 0.08, 0.1, 1.0];

pub enum Target {
    Drm(Box<super::drm::DrmTarget>),
    Rdp(Box<super::rdp::RdpTarget>),
}

pub struct Backend {
    pub renderer: GlesRenderer,
    pub output: Output,
    pub target: Target,
    pub dirty: bool,
    pub presenting: bool,
}

impl Backend {
    pub fn new(renderer: GlesRenderer, output: Output, target: Target) -> Self {
        Self { renderer, output, target, dirty: true, presenting: false }
    }

    pub fn damaged(&mut self) {
        self.dirty = true;
    }
}
