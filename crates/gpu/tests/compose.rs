use std::sync::Arc;

use acde_gpu::{Backdrop, ColorMatrix, Composer, Effect, Gpu, Shadow, wgpu};

const W: u32 = 128;
const H: u32 = 64;
const PHASES: [u32; 8] = [0, 1, 2, 3, 4, 5, 6, 7];

struct Bench {
    gpu: Arc<Gpu>,
    composer: Composer,
    canvas: wgpu::Texture,
}

impl Bench {
    fn new() -> Self {
        let (_, _, gpu) = Gpu::open("acde compose test").expect("a GPU");
        let composer = Composer::new(&gpu.device, &gpu.queue);
        let usage =
            wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
        let canvas = acde_gpu::texture(&gpu.device, (W, H), usage, "test canvas");
        Self { gpu, composer, canvas }
    }

    fn fill(&self, texture: &wgpu::Texture, pixels: &[[u8; 4]]) {
        let bytes: Vec<u8> = pixels.iter().flatten().copied().collect();
        self.gpu.queue.write_texture(
            texture.as_image_copy(),
            &bytes,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(W * 4), rows_per_image: Some(H) },
            wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
        );
    }

    fn layer(&mut self, pixels: &[[u8; 4]]) {
        let view = self.composer.layer_view((W, H));
        self.fill(view.texture(), pixels);
    }

    fn run(&mut self, draw: impl FnOnce(&mut Composer, &mut wgpu::CommandEncoder, &wgpu::TextureView)) -> Vec<[u8; 4]> {
        let view = self.canvas.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("test") });
        draw(&mut self.composer, &mut encoder, &view);
        self.composer.flush();
        self.gpu.submit([encoder.finish()]);
        self.composer.end_frame();
        let bytes = self.gpu.read(&self.canvas, [0, 0, W, H]).expect("read back");
        bytes.as_chunks::<4>().0.to_vec()
    }

    fn blurred(&mut self, sigma: f32, at: u32) -> Vec<[u8; 4]> {
        self.layer(&edge([255, 255, 255, 255], [0, 0, 0, 255], at));
        self.fill(&self.canvas, &vec![[0; 4]; (W * H) as usize]);
        let mut effect = Effect::default();
        effect.blur(sigma);
        self.run(|c, e, canvas| c.filtered(e, canvas, &effect, [0, 0, W, H], [0, 0, W, H]))
    }
}

fn edge(left: [u8; 4], right: [u8; 4], at: u32) -> Vec<[u8; 4]> {
    (0..W * H).map(|i| if i % W < at { left } else { right }).collect()
}

fn row(pixels: &[[u8; 4]], y: u32) -> Vec<f64> {
    pixels[(y * W) as usize..((y + 1) * W) as usize].iter().map(|p| f64::from(p[0]) / 255.0).collect()
}

fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.327_591_1 * x.abs());
    let y = 1.0 - (((((1.061_405_429 * t - 1.453_152_027) * t) + 1.421_413_741) * t - 0.284_496_736) * t + 0.254_829_592) * t * (-x * x).exp();
    y.copysign(x)
}

fn gaussian_edge(sigma: f64, at: u32) -> Vec<f64> {
    let middle = f64::from(at);
    (0..W).map(|x| 0.5 * (1.0 - erf((f64::from(x) + 0.5 - middle) / (sigma * std::f64::consts::SQRT_2)))).collect()
}

fn spread(profile: &[f64]) -> f64 {
    let slope: Vec<f64> = profile.windows(2).map(|w| (w[0] - w[1]).max(0.0)).collect();
    let total: f64 = slope.iter().sum();
    let mean = slope.iter().enumerate().map(|(i, s)| i as f64 * s).sum::<f64>() / total;
    (slope.iter().enumerate().map(|(i, s)| (i as f64 - mean).powi(2) * s).sum::<f64>() / total).sqrt()
}

fn worst(a: &[f64], b: &[f64]) -> f64 {
    a.iter().zip(b).map(|(a, b)| (a - b).abs()).fold(0.0, f64::max)
}

#[test]
fn blur_follows_a_gaussian_of_its_sigma() {
    let mut bench = Bench::new();
    let mut profiles = Vec::new();
    for sigma in [1.0, 3.0, 6.0] {
        let got = row(&bench.blurred(sigma, W / 2), H / 2);
        let want = gaussian_edge(f64::from(sigma), W / 2);
        let (got_spread, want_spread) = (spread(&got), spread(&want));
        assert!((got_spread - want_spread).abs() < 0.2 * want_spread + 0.15, "sigma {sigma}: the edge spreads {got_spread:.2} px, a Gaussian {want_spread:.2}");
        assert!(worst(&got, &want) < 0.08, "sigma {sigma}: off the Gaussian edge by {:.3}\n{got:.2?}\n{want:.2?}", worst(&got, &want));
        profiles.push(got);
    }
    assert!(worst(&profiles[0], &profiles[1]) > 0.1, "blur(1px) and blur(3px) look the same");
    assert!(worst(&profiles[1], &profiles[2]) > 0.1, "blur(3px) and blur(6px) look the same");
}

#[test]
fn blur_grows_without_steps() {
    let mut bench = Bench::new();
    let mut last = 0.0;
    for tenth in 5..=80 {
        let sigma = tenth as f32 / 10.0;
        let got = PHASES.map(|p| spread(&row(&bench.blurred(sigma, W / 2 + p), H / 2))).iter().sum::<f64>() / PHASES.len() as f64;
        assert!(got > last - 0.05, "sigma {sigma} spreads {got:.3} px, less than {last:.3} before");
        last = got;
    }
}

#[test]
fn shadow_without_blur_is_sharp() {
    let mut bench = Bench::new();
    let square = |x: i64, y: i64| (16..48).contains(&x) && (16..48).contains(&y);
    let layer: Vec<[u8; 4]> = (0..i64::from(W * H)).map(|i| if square(i % i64::from(W), i / i64::from(W)) { [255; 4] } else { [0; 4] }).collect();
    bench.layer(&layer);
    bench.fill(&bench.canvas, &vec![[0; 4]; (W * H) as usize]);
    let shadow = Shadow { dx: 2.0, dy: 3.0, blur: 0.0, color: [0.0, 0.0, 1.0, 1.0] };
    let got = bench.run(|c, e, canvas| c.shadow(e, canvas, &shadow, [0, 0, 64, 64], [0, 0, W, H]));
    for y in 0..i64::from(H) {
        for x in 0..i64::from(W) {
            let want = if square(x - 2, y - 3) { [0, 0, 255, 255] } else { [0; 4] };
            assert_eq!(got[(y * i64::from(W) + x) as usize], want, "at ({x}, {y})");
        }
    }
}

#[test]
fn backdrop_without_blur_keeps_edges() {
    let mut bench = Bench::new();
    let (left, right) = ([200, 120, 80, 255], [60, 90, 160, 255]);
    bench.fill(&bench.canvas, &edge(left, right, W / 2));
    let backdrop = Backdrop { rect: [8.0, 8.0, 112.0, 48.0], radius: 0.0, blur: 0.0, saturate: 2.0, brightness: 1.0 };
    let got = bench.run(|c, e, canvas| c.backdrop(e, canvas, &backdrop));
    let saturated = |p: [u8; 4]| {
        let m = ColorMatrix::saturate(2.0).0;
        let c = p.map(|v| f32::from(v) / 255.0);
        std::array::from_fn::<u8, 4, _>(|i| {
            let v = (0..4).map(|j| m[i * 5 + j] * c[j]).sum::<f32>() + m[i * 5 + 4];
            (v.clamp(0.0, 1.0) * 255.0).round() as u8
        })
    };
    for x in 8..120u32 {
        let want = saturated(if x < W / 2 { left } else { right });
        let p = got[(32 * W + x) as usize];
        assert!(p.iter().zip(want).all(|(a, b)| a.abs_diff(b) <= 3), "at x {x}: {p:?}, want {want:?}");
    }
}
