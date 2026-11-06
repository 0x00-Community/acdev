use crate::Scene;

pub trait Images {
    fn apply(&mut self, vello: &mut vello::Renderer, scene: &Scene);
    fn submitted(&mut self);
    fn forget(&mut self, vello: &mut vello::Renderer);
}

impl Images for () {
    fn apply(&mut self, _: &mut vello::Renderer, _: &Scene) {}
    fn submitted(&mut self) {}
    fn forget(&mut self, _: &mut vello::Renderer) {}
}
