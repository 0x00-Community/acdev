use acde_webgl::consts::*;
use acde_webgl::{Attributes, Context, Setter};

fn gpu() -> Option<std::sync::Arc<acde_gpu::Gpu>> {
    acde_gpu::Gpu::open("webgl test").ok().map(|(.., g)| g)
}

fn program(gl: &mut Context, vs: &str, fs: &str) -> u32 {
    let v = gl.create_shader(VERTEX_SHADER).unwrap();
    gl.shader_source(v, vs);
    gl.compile_shader(v);
    assert_eq!(gl.shader_info_log(v).unwrap(), "");
    let f = gl.create_shader(FRAGMENT_SHADER).unwrap();
    gl.shader_source(f, fs);
    gl.compile_shader(f);
    assert_eq!(gl.shader_info_log(f).unwrap(), "");
    let p = gl.create_program();
    gl.attach_shader(p, v);
    gl.attach_shader(p, f);
    gl.link_program(p);
    assert_eq!(gl.program_info_log(p).unwrap(), "");
    p
}

fn pixel(gl: &mut Context, x: i32, y: i32) -> [u8; 4] {
    let mut out = [0u8; 4];
    gl.read_pixels(x, y, 1, 1, RGBA, UNSIGNED_BYTE, &mut out);
    out
}

fn floats(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|f| f.to_le_bytes()).collect()
}

#[test]
fn triangle_and_clear() {
    let _ = env_logger::builder().is_test(true).try_init();
    let Some(gpu) = gpu() else { return };
    for (webgl2, antialias) in [(false, false), (true, true)] {
        let mut gl = Context::new(gpu.clone(), webgl2, Attributes { antialias, ..Default::default() }, 64, 64);
        gl.clear_color(0.0, 0.0, 1.0, 1.0);
        gl.clear(COLOR_BUFFER_BIT);
        assert_eq!(pixel(&mut gl, 1, 1), [0, 0, 255, 255]);
        let p = program(
            &mut gl,
            "attribute vec2 p; attribute vec3 c; varying vec3 v; void main() { v = c; gl_Position = vec4(p, 0.0, 1.0); }",
            "precision mediump float; varying vec3 v; uniform float k; void main() { gl_FragColor = vec4(v * k, 1.0); }",
        );
        gl.use_program(Some(p));
        let b = gl.create_buffer();
        gl.bind_buffer(ARRAY_BUFFER, Some(b));
        gl.buffer_data(ARRAY_BUFFER, Some(&floats(&[-1.0, -1.0, 1.0, 0.0, 0.0, 1.0, -1.0, 0.0, 1.0, 0.0, -1.0, 1.0, 0.0, 0.0, 1.0])), 0, STATIC_DRAW);
        let pl = gl.attrib_location(p, "p") as u32;
        let cl = gl.attrib_location(p, "c") as u32;
        gl.vertex_attrib_pointer(pl, 2, FLOAT, false, 20, 0, false);
        gl.vertex_attrib_pointer(cl, 3, FLOAT, false, 20, 8, false);
        gl.enable_vertex_attrib(pl, true);
        gl.enable_vertex_attrib(cl, true);
        let k = gl.uniform_location(p, "k").unwrap();
        let serial = gl.program_serial(p);
        gl.uniform(Some(p), k, serial, Setter::Float(1), false, &floats(&[1.0]));
        gl.draw(TRIANGLES, 0, 3, 1, None);
        assert_eq!(gl.get_error(), NO_ERROR);
        let near = |a: [u8; 4], b: [u8; 4]| a.iter().zip(b).all(|(x, y)| (i16::from(*x) - i16::from(y)).abs() < 24);
        let bl = pixel(&mut gl, 2, 2);
        assert!(near(bl, [255, 0, 0, 255]), "bottom left is red (GL origin): {bl:?}");
        let br = pixel(&mut gl, 60, 1);
        assert!(near(br, [0, 255, 0, 255]), "bottom right is green: {br:?}");
        let tl = pixel(&mut gl, 1, 59);
        assert!(near(tl, [0, 0, 255, 255]), "top left is blue: {tl:?}");
        assert_eq!(pixel(&mut gl, 62, 62), [0, 0, 255, 255], "top right is the clear colour");
        gl.uniform(Some(p), k, serial, Setter::Float(1), false, &floats(&[0.0]));
        gl.enable(SCISSOR_TEST, true);
        gl.scissor(0, 0, 8, 8);
        gl.clear_color(1.0, 1.0, 0.0, 1.0);
        gl.clear(COLOR_BUFFER_BIT);
        gl.enable(SCISSOR_TEST, false);
        assert_eq!(pixel(&mut gl, 3, 3), [255, 255, 0, 255], "scissored clear");
        gl.draw(TRIANGLES, 0, 3, 1, None);
        assert_eq!(pixel(&mut gl, 3, 3), [0, 0, 0, 255], "uniform k = 0");
        assert!(gl.present().is_some());
    }
}

#[test]
fn culling_and_front_facing() {
    let Some(gpu) = gpu() else { return };
    let mut gl = Context::new(gpu, true, Attributes { antialias: false, ..Default::default() }, 8, 8);
    let p = program(
        &mut gl,
        "#version 300 es\nin vec2 p; void main() { gl_Position = vec4(p, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; out vec4 o; void main() { o = gl_FrontFacing ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0); }",
    );
    gl.use_program(Some(p));
    let b = gl.create_buffer();
    gl.bind_buffer(ARRAY_BUFFER, Some(b));
    gl.buffer_data(ARRAY_BUFFER, Some(&floats(&[-1.0, -1.0, 3.0, -1.0, -1.0, 3.0])), 0, STATIC_DRAW);
    gl.vertex_attrib_pointer(0, 2, FLOAT, false, 0, 0, false);
    gl.enable_vertex_attrib(0, true);
    gl.draw(TRIANGLES, 0, 3, 1, None);
    assert_eq!(pixel(&mut gl, 4, 4), [0, 255, 0, 255], "a CCW triangle is front facing");
    gl.enable(CULL_FACE, true);
    gl.clear(COLOR_BUFFER_BIT);
    gl.draw(TRIANGLES, 0, 3, 1, None);
    assert_eq!(pixel(&mut gl, 4, 4), [0, 255, 0, 255], "back-face culling keeps a CCW triangle");
    gl.cull_face(FRONT);
    gl.clear(COLOR_BUFFER_BIT);
    gl.draw(TRIANGLES, 0, 3, 1, None);
    assert_eq!(pixel(&mut gl, 4, 4), [0, 0, 0, 0], "front-face culling drops it");
}

#[test]
fn converted_attributes() {
    let Some(gpu) = gpu() else { return };
    let mut gl = Context::new(gpu, true, Attributes { antialias: false, ..Default::default() }, 8, 8);
    let p = program(
        &mut gl,
        "#version 300 es\nin vec2 p; in vec4 k; out vec4 v; void main() { v = k; gl_Position = vec4(p, 0.0, 1.0); }",
        "#version 300 es\nprecision mediump float; in vec4 v; out vec4 o; void main() { o = v / 255.0; }",
    );
    gl.use_program(Some(p));
    let b = gl.create_buffer();
    gl.bind_buffer(ARRAY_BUFFER, Some(b));
    gl.buffer_data(ARRAY_BUFFER, Some(&floats(&[-1.0, -1.0, 3.0, -1.0, -1.0, 3.0])), 0, STATIC_DRAW);
    let pl = gl.attrib_location(p, "p") as u32;
    let kl = gl.attrib_location(p, "k") as u32;
    gl.vertex_attrib_pointer(pl, 2, FLOAT, false, 0, 0, false);
    gl.enable_vertex_attrib(pl, true);
    let k = gl.create_buffer();
    gl.bind_buffer(ARRAY_BUFFER, Some(k));
    let shorts: Vec<u8> = [255u16, 0, 128, 255].repeat(3).iter().flat_map(|s| s.to_le_bytes()).collect();
    gl.buffer_data(ARRAY_BUFFER, Some(&shorts), 0, STATIC_DRAW);
    gl.vertex_attrib_pointer(kl, 4, UNSIGNED_SHORT, false, 0, 0, false);
    gl.enable_vertex_attrib(kl, true);
    gl.draw(TRIANGLES, 0, 3, 1, None);
    assert_eq!(gl.get_error(), 0);
    assert_eq!(pixel(&mut gl, 4, 4), [255, 0, 128, 255], "UNSIGNED_SHORT x4 non-normalized becomes float");
}
