use std::collections::HashMap;

use smithay::backend::allocator::Fourcc;
use smithay::backend::renderer::element::{Element, Id, Kind, RenderElement};
use smithay::backend::renderer::gles::{GlesError, GlesFrame, GlesRenderer, GlesTexProgram, GlesTexture, Uniform, UniformName, UniformType};
use smithay::backend::renderer::utils::{CommitCounter, DamageSet, OpaqueRegions};
use smithay::backend::renderer::{Bind, Frame, Offscreen, Renderer, Texture};
use smithay::utils::{Buffer, Physical, Point, Rectangle, Scale, Size, Transform};

use super::backend::{CLEAR, Elements};

const DOWN: &str = "#version 100
//_DEFINES_
#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif
precision mediump float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif
uniform float alpha;
uniform vec2 texel;
varying vec2 v_coords;
void main() {
    vec2 h = texel;
    vec4 sum = texture2D(tex, v_coords) * 4.0;
    sum += texture2D(tex, v_coords - h);
    sum += texture2D(tex, v_coords + h);
    sum += texture2D(tex, v_coords + vec2(h.x, -h.y));
    sum += texture2D(tex, v_coords - vec2(h.x, -h.y));
    gl_FragColor = sum / 8.0 * alpha;
}";

const UP: &str = "#version 100
//_DEFINES_
#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif
precision mediump float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif
uniform float alpha;
uniform vec2 texel;
varying vec2 v_coords;
void main() {
    vec2 h = texel;
    vec4 sum = texture2D(tex, v_coords + vec2(-h.x * 2.0, 0.0));
    sum += texture2D(tex, v_coords + vec2(-h.x, h.y)) * 2.0;
    sum += texture2D(tex, v_coords + vec2(0.0, h.y * 2.0));
    sum += texture2D(tex, v_coords + vec2(h.x, h.y)) * 2.0;
    sum += texture2D(tex, v_coords + vec2(h.x * 2.0, 0.0));
    sum += texture2D(tex, v_coords + vec2(h.x, -h.y)) * 2.0;
    sum += texture2D(tex, v_coords + vec2(0.0, -h.y * 2.0));
    sum += texture2D(tex, v_coords + vec2(-h.x, -h.y)) * 2.0;
    gl_FragColor = sum / 12.0 * alpha;
}";

const BACKDROP: &str = "#version 100
//_DEFINES_
#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif
precision mediump float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif
uniform float alpha;
uniform vec2 size;
uniform vec4 rect;
uniform float radius;
uniform float saturate;
uniform float brightness;
varying vec2 v_coords;
void main() {
    vec4 c = texture2D(tex, v_coords);
    float luma = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    c = vec4(mix(vec3(luma), c.rgb, saturate) * brightness, c.a);
    vec2 half_size = rect.zw * 0.5;
    vec2 p = v_coords * size - rect.xy - half_size;
    float r = min(radius, min(half_size.x, half_size.y));
    vec2 q = abs(p) - half_size + vec2(r);
    float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - r;
    gl_FragColor = c * clamp(0.5 - d, 0.0, 1.0) * alpha;
}";

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Backdrop {
    pub rect: Rectangle<i32, Physical>,
    pub radius: f32,
    pub blur: f32,
    pub saturate: f32,
    pub brightness: f32,
    pub screen: Size<i32, Physical>,
    pub scale: f64,
}

#[derive(Debug, Clone)]
pub struct BackdropElement {
    id: Id,
    texture: GlesTexture,
    program: GlesTexProgram,
    rect: Rectangle<i32, Physical>,
    src: Rectangle<f64, Buffer>,
    uniforms: Vec<Uniform<'static>>,
}

impl Element for BackdropElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        CommitCounter::default()
    }

    fn geometry(&self, _: Scale<f64>) -> Rectangle<i32, Physical> {
        self.rect
    }

    fn src(&self) -> Rectangle<f64, Buffer> {
        self.src
    }

    fn damage_since(&self, _: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        match commit {
            Some(_) => DamageSet::default(),
            None => DamageSet::from_slice(&[Rectangle::from_size(self.rect.size)]),
        }
    }

    fn opaque_regions(&self, _: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        OpaqueRegions::default()
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl RenderElement<GlesRenderer> for BackdropElement {
    fn draw(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        src: Rectangle<f64, Buffer>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        _: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        frame.render_texture_from_to(&self.texture, src, dst, damage, &[], Transform::Normal, 1.0, Some(&self.program), &self.uniforms)
    }
}

struct Programs {
    down: GlesTexProgram,
    up: GlesTexProgram,
    backdrop: GlesTexProgram,
}

struct Cached {
    key: Backdrop,
    element: BackdropElement,
}

#[derive(Default)]
pub struct Effects {
    programs: Option<Result<Programs, ()>>,
    cache: HashMap<u32, Cached>,
}

impl Effects {
    fn programs(&mut self, renderer: &mut GlesRenderer) -> Option<&Programs> {
        let programs = self.programs.get_or_insert_with(|| {
            let texel = [UniformName::new("texel", UniformType::_2f)];
            let backdrop = [
                UniformName::new("size", UniformType::_2f),
                UniformName::new("rect", UniformType::_4f),
                UniformName::new("radius", UniformType::_1f),
                UniformName::new("saturate", UniformType::_1f),
                UniformName::new("brightness", UniformType::_1f),
            ];
            let built = (|| {
                Ok::<_, GlesError>(Programs {
                    down: renderer.compile_custom_texture_shader(DOWN, &texel)?,
                    up: renderer.compile_custom_texture_shader(UP, &texel)?,
                    backdrop: renderer.compile_custom_texture_shader(BACKDROP, &backdrop)?,
                })
            })();
            built.map_err(|e| log::warn!("backdrop 着色器编译失败, backdrop 不处理: {e}"))
        });
        programs.as_ref().ok()
    }

    pub fn retain(&mut self, live: impl Fn(u32) -> bool) {
        self.cache.retain(|id, _| live(*id));
    }

    pub fn backdrop(&mut self, renderer: &mut GlesRenderer, window: u32, backdrop: Backdrop, below: &[Elements], dirty: bool) -> Option<BackdropElement> {
        if !dirty && let Some(cached) = self.cache.get(&window).filter(|c| c.key == backdrop) {
            return Some(cached.element.clone());
        }
        let started = std::time::Instant::now();
        let element = self.blurred(renderer, backdrop, below).inspect_err(|e| log::warn!("backdrop: {e}")).ok()??;
        log::debug!(target: "perf::compose", "backdrop window={window} w={} h={} blur={} ms={:.3}", backdrop.rect.size.w, backdrop.rect.size.h, backdrop.blur, acde_log::since_ms(started));
        self.cache.insert(window, Cached { key: backdrop, element: element.clone() });
        Some(element)
    }

    fn blurred(&mut self, renderer: &mut GlesRenderer, b: Backdrop, below: &[Elements]) -> Result<Option<BackdropElement>, GlesError> {
        let (screen, scale) = (b.screen, b.scale);
        let rect = match b.rect.intersection(Rectangle::from_size(screen)) {
            Some(r) if r.size.w > 1 && r.size.h > 1 => r,
            _ => return Ok(None),
        };
        let levels = acde_model::blur_levels(b.blur);
        let margin = acde_model::blur_margin(levels);
        let Some(region) = Rectangle::new(rect.loc - Point::from((margin, margin)), rect.size + Size::from((2 * margin, 2 * margin)))
            .intersection(Rectangle::from_size(screen))
        else {
            return Ok(None);
        };
        let Some((down, up, program)) = self.programs(renderer).map(|p| (p.down.clone(), p.up.clone(), p.backdrop.clone())) else { return Ok(None) };
        let buffer = |s: Size<i32, Physical>| Size::<i32, Buffer>::from((s.w.max(1), s.h.max(1)));
        let mut base: GlesTexture = renderer.create_buffer(Fourcc::Abgr8888, buffer(region.size))?;
        {
            let mut fb = renderer.bind(&mut base)?;
            let mut frame = renderer.render(&mut fb, region.size, Transform::Normal)?;
            frame.clear(CLEAR.into(), &[Rectangle::from_size(region.size)])?;
            for element in below.iter().rev() {
                let geometry = element.geometry(scale.into());
                let dst = Rectangle::new(geometry.loc - region.loc, geometry.size);
                if dst.intersection(Rectangle::from_size(region.size)).is_none() {
                    continue;
                }
                element.draw(&mut frame, element.src(), dst, &[Rectangle::from_size(dst.size)], &[])?;
            }
            let _ = frame.finish()?;
        }
        let mut chain = vec![base];
        for _ in 0..levels {
            let from = chain.last().map(|t| t.size()).unwrap_or_default();
            let size = Size::<i32, Physical>::from(((from.w / 2).max(1), (from.h / 2).max(1)));
            let next = Self::pass(renderer, &chain[chain.len() - 1], size, &down)?;
            chain.push(next);
        }
        let mut current = chain.pop().expect("blur chain");
        while let Some(target) = chain.pop() {
            let size = target.size();
            current = Self::pass(renderer, &current, Size::from((size.w, size.h)), &up)?;
        }
        let inner = Rectangle::new(rect.loc - region.loc, rect.size);
        let uniforms = vec![
            Uniform::new("size", (region.size.w as f32, region.size.h as f32)),
            Uniform::new("rect", (inner.loc.x as f32, inner.loc.y as f32, inner.size.w as f32, inner.size.h as f32)),
            Uniform::new("radius", b.radius),
            Uniform::new("saturate", b.saturate),
            Uniform::new("brightness", b.brightness),
        ];
        let src = Rectangle::new((f64::from(inner.loc.x), f64::from(inner.loc.y)).into(), (f64::from(inner.size.w), f64::from(inner.size.h)).into());
        Ok(Some(BackdropElement { id: Id::new(), texture: current, program, rect, src, uniforms }))
    }

    fn pass(renderer: &mut GlesRenderer, src: &GlesTexture, size: Size<i32, Physical>, program: &GlesTexProgram) -> Result<GlesTexture, GlesError> {
        let from = src.size();
        let mut target: GlesTexture = renderer.create_buffer(Fourcc::Abgr8888, Size::from((size.w, size.h)))?;
        {
            let mut fb = renderer.bind(&mut target)?;
            let mut frame = renderer.render(&mut fb, size, Transform::Normal)?;
            let all = Rectangle::from_size(size);
            frame.clear([0.0; 4].into(), &[all])?;
            let texel = Uniform::new("texel", (1.0 / from.w.max(1) as f32, 1.0 / from.h.max(1) as f32));
            frame.render_texture_from_to(src, Rectangle::from_size(from.to_f64()), all, &[all], &[], Transform::Normal, 1.0, Some(program), &[texel])?;
            let _ = frame.finish()?;
        }
        Ok(target)
    }
}
