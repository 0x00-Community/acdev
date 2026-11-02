// 网页图层在 wgpu 里的合成:
// - place: vello 画出的一段 (直通 alpha, 在临时纹理左上角) 预乘后叠到画布 rect 处 (混合 ONE, ONE_MINUS_SRC_ALPHA)
// - clear: 局部重画前清空画布上的一块 (不混合)
// - down / up: dual Kawase 模糊的降采样 / 升采样
// - backdrop: 模糊后的背景按圆角矩形遮罩、调饱和度和亮度, 叠回画布 (毛玻璃)
// - shadow: 模糊后的一段内容只取 alpha, 平移、上色后叠回画布 (drop-shadow, 先于内容本身)
// - filter: 预乘、模糊后的一段内容按颜色矩阵处理后叠回画布 (CSS filter 的 blur / saturate ...)

struct Params {
    // 目标像素的 1/尺寸 (降 / 升采样的半像素偏移用)
    texel: vec2<f32>,
    // 采样偏移倍数 (Kawase 的扩散半径)
    offset: f32,
    saturate: f32,
    // 毛玻璃在画布上的矩形 (像素): x, y, w, h
    rect: vec4<f32>,
    radius: f32,
    brightness: f32,
    // drop-shadow 的偏移 (像素)
    shift: vec2<f32>,
    // drop-shadow 的颜色 (直通 alpha)
    color: vec4<f32>,
    // filter 的颜色矩阵 (直通 alpha 上算) 和偏移
    matrix: mat4x4<f32>,
    bias: vec4<f32>,
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var<uniform> params: Params;

struct VsOut {
    @builtin(position) pos: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

// 覆盖整个视口的三角形
@vertex
fn vs_full(@builtin(vertex_index) i: u32) -> VsOut {
    let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var out: VsOut;
    out.pos = vec4<f32>(uv * vec2<f32>(2.0, -2.0) + vec2<f32>(-1.0, 1.0), 0.0, 1.0);
    out.uv = uv;
    return out;
}

@fragment
fn fs_clear(in: VsOut) -> @location(0) vec4<f32> {
    return vec4<f32>(0.0);
}

// 已经预乘的一段 (vello_cpu 画的) 原样叠到画布上
@fragment
fn fs_place_premultiplied(in: VsOut) -> @location(0) vec4<f32> {
    return textureLoad(src, vec2<i32>(in.pos.xy - params.rect.xy), 0);
}

@fragment
fn fs_place(in: VsOut) -> @location(0) vec4<f32> {
    let c = textureLoad(src, vec2<i32>(in.pos.xy - params.rect.xy), 0);
    return vec4<f32>(c.rgb * c.a, c.a);
}

@fragment
fn fs_down(in: VsOut) -> @location(0) vec4<f32> {
    let h = params.texel * params.offset;
    var sum = textureSample(src, samp, in.uv) * 4.0;
    sum += textureSample(src, samp, in.uv - h);
    sum += textureSample(src, samp, in.uv + h);
    sum += textureSample(src, samp, in.uv + vec2<f32>(h.x, -h.y));
    sum += textureSample(src, samp, in.uv - vec2<f32>(h.x, -h.y));
    return sum / 8.0;
}

@fragment
fn fs_up(in: VsOut) -> @location(0) vec4<f32> {
    let h = params.texel * params.offset;
    var sum = textureSample(src, samp, in.uv + vec2<f32>(-h.x * 2.0, 0.0));
    sum += textureSample(src, samp, in.uv + vec2<f32>(-h.x, h.y)) * 2.0;
    sum += textureSample(src, samp, in.uv + vec2<f32>(0.0, h.y * 2.0));
    sum += textureSample(src, samp, in.uv + vec2<f32>(h.x, h.y)) * 2.0;
    sum += textureSample(src, samp, in.uv + vec2<f32>(h.x * 2.0, 0.0));
    sum += textureSample(src, samp, in.uv + vec2<f32>(h.x, -h.y)) * 2.0;
    sum += textureSample(src, samp, in.uv + vec2<f32>(0.0, -h.y * 2.0));
    sum += textureSample(src, samp, in.uv + vec2<f32>(-h.x, -h.y)) * 2.0;
    return sum / 12.0;
}

// 圆角矩形的有符号距离 (p 相对中心)
fn rounded_rect(p: vec2<f32>, half: vec2<f32>, r: f32) -> f32 {
    let q = abs(p) - half + vec2<f32>(r, r);
    return length(max(q, vec2<f32>(0.0, 0.0))) + min(max(q.x, q.y), 0.0) - r;
}

// 原样拷贝 (已经预乘的画布), 源坐标 = 目标坐标 + rect.xy; 配 over 混合把上层叠到背景的拷贝上
@fragment
fn fs_copy(in: VsOut) -> @location(0) vec4<f32> {
    return textureLoad(src, vec2<i32>(in.pos.xy + params.rect.xy), 0);
}

// src 是已模糊的背景 (预乘, 覆盖 rect), 在画布坐标系里按圆角遮罩画回去
@fragment
fn fs_backdrop(in: VsOut) -> @location(0) vec4<f32> {
    let px = in.pos.xy;
    let local = (px - params.rect.xy) / params.rect.zw;
    var c = textureSample(src, samp, clamp(local, vec2<f32>(0.0), vec2<f32>(1.0)));
    // 饱和度: 和亮度的灰度插值 (CSS saturate 的近似)
    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    c = vec4<f32>(mix(vec3<f32>(luma), c.rgb, params.saturate) * params.brightness, c.a);
    let half = params.rect.zw * 0.5;
    let d = rounded_rect(px - params.rect.xy - half, half, min(params.radius, min(half.x, half.y)));
    let mask = clamp(0.5 - d, 0.0, 1.0);
    return c * mask;
}

// src 是已模糊的一段内容 (覆盖 rect, 直通 alpha); 画布像素 p 处的阴影取内容在 p - shift 处的 alpha
@fragment
fn fs_shadow(in: VsOut) -> @location(0) vec4<f32> {
    let local = (in.pos.xy - params.shift - params.rect.xy) / params.rect.zw;
    if any(local < vec2<f32>(0.0)) || any(local > vec2<f32>(1.0)) {
        return vec4<f32>(0.0);
    }
    let a = textureSample(src, samp, local).a * params.color.a;
    return vec4<f32>(params.color.rgb * a, a);
}

// src 是这一段内容 (预乘, 已模糊, 覆盖 rect); 按颜色矩阵处理后叠到画布
@fragment
fn fs_filter(in: VsOut) -> @location(0) vec4<f32> {
    let p = textureSample(src, samp, (in.pos.xy - params.rect.xy) / params.rect.zw);
    let c = select(vec4<f32>(0.0), vec4<f32>(p.rgb / p.a, p.a), p.a > 0.0);
    let m = clamp(params.matrix * c + params.bias, vec4<f32>(0.0), vec4<f32>(1.0));
    return vec4<f32>(m.rgb * m.a, m.a);
}
