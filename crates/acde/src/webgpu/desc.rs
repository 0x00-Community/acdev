use std::collections::HashMap;
use std::num::NonZeroU64;

use acde_render::anyrender_vello::wgpu;
use serde::Deserialize;
use wgpu::{
    AddressMode, BlendFactor, BlendOperation, CompareFunction, Face, FilterMode, FrontFace, IndexFormat, MipmapFilterMode, PrimitiveTopology, SamplerBindingType,
    StencilOperation, StorageTextureAccess, TextureAspect, TextureDimension, TextureFormat, TextureViewDimension, VertexFormat, VertexStepMode,
};

pub fn label(label: &Option<String>) -> Option<&str> {
    label.as_deref().filter(|l| !l.is_empty())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferDesc {
    pub label: Option<String>,
    pub size: u64,
    pub usage: u32,
    #[serde(default)]
    pub mapped_at_creation: bool,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct Extent {
    pub width: u32,
    #[serde(default = "one")]
    pub height: u32,
    #[serde(default = "one")]
    pub depth_or_array_layers: u32,
}

impl From<Extent> for wgpu::Extent3d {
    fn from(e: Extent) -> Self {
        wgpu::Extent3d { width: e.width, height: e.height, depth_or_array_layers: e.depth_or_array_layers }
    }
}

#[derive(Deserialize, Clone, Copy, Default)]
pub struct Origin {
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(default)]
    pub z: u32,
}

fn one() -> u32 {
    1
}

fn all_bits() -> u32 {
    u32::MAX
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureDesc {
    pub label: Option<String>,
    pub size: Extent,
    #[serde(default = "one")]
    pub mip_level_count: u32,
    #[serde(default = "one")]
    pub sample_count: u32,
    #[serde(default = "d2")]
    pub dimension: TextureDimension,
    pub format: TextureFormat,
    pub usage: u32,
    #[serde(default)]
    pub view_formats: Vec<TextureFormat>,
}

fn d2() -> TextureDimension {
    TextureDimension::D2
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewDesc {
    pub label: Option<String>,
    pub format: Option<TextureFormat>,
    pub dimension: Option<TextureViewDimension>,
    pub usage: Option<u32>,
    #[serde(default = "aspect_all")]
    pub aspect: TextureAspect,
    #[serde(default)]
    pub base_mip_level: u32,
    pub mip_level_count: Option<u32>,
    #[serde(default)]
    pub base_array_layer: u32,
    pub array_layer_count: Option<u32>,
}

fn aspect_all() -> TextureAspect {
    TextureAspect::All
}

impl ViewDesc {
    pub fn wgpu(&self) -> wgpu::TextureViewDescriptor<'_> {
        wgpu::TextureViewDescriptor {
            label: label(&self.label),
            format: self.format,
            dimension: self.dimension,
            usage: self.usage.map(wgpu::TextureUsages::from_bits_truncate),
            aspect: self.aspect,
            base_mip_level: self.base_mip_level,
            mip_level_count: self.mip_level_count,
            base_array_layer: self.base_array_layer,
            array_layer_count: self.array_layer_count,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplerDesc {
    pub label: Option<String>,
    #[serde(default = "clamp")]
    pub address_mode_u: AddressMode,
    #[serde(default = "clamp")]
    pub address_mode_v: AddressMode,
    #[serde(default = "clamp")]
    pub address_mode_w: AddressMode,
    #[serde(default = "nearest")]
    pub mag_filter: FilterMode,
    #[serde(default = "nearest")]
    pub min_filter: FilterMode,
    #[serde(default = "mip_nearest")]
    pub mipmap_filter: MipmapFilterMode,
    #[serde(default)]
    pub lod_min_clamp: f32,
    #[serde(default = "lod_max")]
    pub lod_max_clamp: f32,
    pub compare: Option<CompareFunction>,
    #[serde(default = "anisotropy")]
    pub max_anisotropy: u16,
}

fn clamp() -> AddressMode {
    AddressMode::ClampToEdge
}
fn nearest() -> FilterMode {
    FilterMode::Nearest
}
fn mip_nearest() -> MipmapFilterMode {
    MipmapFilterMode::Nearest
}
fn lod_max() -> f32 {
    32.0
}
fn anisotropy() -> u16 {
    1
}

impl SamplerDesc {
    pub fn wgpu(&self) -> wgpu::SamplerDescriptor<'_> {
        wgpu::SamplerDescriptor {
            label: label(&self.label),
            address_mode_u: self.address_mode_u,
            address_mode_v: self.address_mode_v,
            address_mode_w: self.address_mode_w,
            mag_filter: self.mag_filter,
            min_filter: self.min_filter,
            mipmap_filter: self.mipmap_filter,
            lod_min_clamp: self.lod_min_clamp,
            lod_max_clamp: self.lod_max_clamp,
            compare: self.compare,
            anisotropy_clamp: self.max_anisotropy,
            border_color: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindGroupLayoutDesc {
    pub label: Option<String>,
    pub entries: Vec<LayoutEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LayoutEntry {
    pub binding: u32,
    pub visibility: u32,
    pub buffer: Option<BufferLayout>,
    pub sampler: Option<SamplerLayout>,
    pub texture: Option<TextureLayout>,
    pub storage_texture: Option<StorageTextureLayout>,
    pub external_texture: Option<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferLayout {
    #[serde(rename = "type", default = "uniform")]
    pub kind: String,
    #[serde(default)]
    pub has_dynamic_offset: bool,
    #[serde(default)]
    pub min_binding_size: u64,
}

fn uniform() -> String {
    "uniform".into()
}

#[derive(Deserialize)]
pub struct SamplerLayout {
    #[serde(rename = "type", default = "filtering")]
    pub kind: SamplerBindingType,
}

fn filtering() -> SamplerBindingType {
    SamplerBindingType::Filtering
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureLayout {
    #[serde(default = "float")]
    pub sample_type: String,
    #[serde(default = "view_2d")]
    pub view_dimension: TextureViewDimension,
    #[serde(default)]
    pub multisampled: bool,
}

fn float() -> String {
    "float".into()
}
fn view_2d() -> TextureViewDimension {
    TextureViewDimension::D2
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTextureLayout {
    #[serde(default = "write_only")]
    pub access: StorageTextureAccess,
    pub format: TextureFormat,
    #[serde(default = "view_2d")]
    pub view_dimension: TextureViewDimension,
}

fn write_only() -> StorageTextureAccess {
    StorageTextureAccess::WriteOnly
}

impl LayoutEntry {
    pub fn wgpu(&self) -> Result<wgpu::BindGroupLayoutEntry, String> {
        let ty = if let Some(b) = &self.buffer {
            let ty = match b.kind.as_str() {
                "uniform" => wgpu::BufferBindingType::Uniform,
                "storage" => wgpu::BufferBindingType::Storage { read_only: false },
                "read-only-storage" => wgpu::BufferBindingType::Storage { read_only: true },
                other => return Err(format!("TypeError: '{other}' is not a GPUBufferBindingType")),
            };
            wgpu::BindingType::Buffer { ty, has_dynamic_offset: b.has_dynamic_offset, min_binding_size: NonZeroU64::new(b.min_binding_size) }
        } else if let Some(s) = &self.sampler {
            wgpu::BindingType::Sampler(s.kind)
        } else if let Some(t) = &self.texture {
            let sample_type = match t.sample_type.as_str() {
                "float" => wgpu::TextureSampleType::Float { filterable: true },
                "unfilterable-float" => wgpu::TextureSampleType::Float { filterable: false },
                "depth" => wgpu::TextureSampleType::Depth,
                "sint" => wgpu::TextureSampleType::Sint,
                "uint" => wgpu::TextureSampleType::Uint,
                other => return Err(format!("TypeError: '{other}' is not a GPUTextureSampleType")),
            };
            wgpu::BindingType::Texture { sample_type, view_dimension: t.view_dimension, multisampled: t.multisampled }
        } else if let Some(t) = &self.storage_texture {
            wgpu::BindingType::StorageTexture { access: t.access, format: t.format, view_dimension: t.view_dimension }
        } else if self.external_texture.is_some() {
            return Err("NotSupportedError: external textures are not supported".into());
        } else {
            return Err("TypeError: a bind group layout entry needs exactly one binding type".into());
        };
        Ok(wgpu::BindGroupLayoutEntry { binding: self.binding, visibility: wgpu::ShaderStages::from_bits_truncate(self.visibility), ty, count: None })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineLayoutDesc {
    pub label: Option<String>,
    pub bind_group_layouts: Vec<Option<u32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindGroupDesc {
    pub label: Option<String>,
    pub layout: u32,
    pub entries: Vec<BindGroupEntry>,
}

#[derive(Deserialize)]
pub struct BindGroupEntry {
    pub binding: u32,
    pub resource: Resource,
}

#[derive(Deserialize)]
pub struct Resource {
    pub buffer: Option<u32>,
    #[serde(default)]
    pub offset: u64,
    pub size: Option<u64>,
    pub sampler: Option<u32>,
    pub view: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stage {
    pub module: u32,
    pub entry_point: Option<String>,
    #[serde(default)]
    pub constants: HashMap<String, f64>,
}

impl Stage {
    pub fn constants(&self) -> Vec<(&str, f64)> {
        self.constants.iter().map(|(k, v)| (k.as_str(), *v)).collect()
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePipelineDesc {
    pub label: Option<String>,
    pub layout: Option<u32>,
    pub compute: Stage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPipelineDesc {
    pub label: Option<String>,
    pub layout: Option<u32>,
    pub vertex: VertexDesc,
    #[serde(default)]
    pub primitive: PrimitiveDesc,
    pub depth_stencil: Option<DepthStencilDesc>,
    #[serde(default)]
    pub multisample: MultisampleDesc,
    pub fragment: Option<FragmentDesc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexDesc {
    #[serde(flatten)]
    pub stage: Stage,
    #[serde(default)]
    pub buffers: Vec<Option<VertexBufferDesc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexBufferDesc {
    pub array_stride: u64,
    #[serde(default = "per_vertex")]
    pub step_mode: VertexStepMode,
    pub attributes: Vec<VertexAttributeDesc>,
}

fn per_vertex() -> VertexStepMode {
    VertexStepMode::Vertex
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VertexAttributeDesc {
    pub format: VertexFormat,
    pub offset: u64,
    pub shader_location: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrimitiveDesc {
    #[serde(default = "triangles")]
    pub topology: PrimitiveTopology,
    pub strip_index_format: Option<IndexFormat>,
    #[serde(default = "ccw")]
    pub front_face: FrontFace,
    #[serde(default = "no_cull")]
    pub cull_mode: String,
    #[serde(default)]
    pub unclipped_depth: bool,
}

impl Default for PrimitiveDesc {
    fn default() -> Self {
        Self { topology: triangles(), strip_index_format: None, front_face: ccw(), cull_mode: no_cull(), unclipped_depth: false }
    }
}

fn triangles() -> PrimitiveTopology {
    PrimitiveTopology::TriangleList
}
fn ccw() -> FrontFace {
    FrontFace::Ccw
}
fn no_cull() -> String {
    "none".into()
}

impl PrimitiveDesc {
    pub fn wgpu(&self) -> Result<wgpu::PrimitiveState, String> {
        let cull_mode = match self.cull_mode.as_str() {
            "none" => None,
            "front" => Some(Face::Front),
            "back" => Some(Face::Back),
            other => return Err(format!("TypeError: '{other}' is not a GPUCullMode")),
        };
        Ok(wgpu::PrimitiveState {
            topology: self.topology,
            strip_index_format: self.strip_index_format,
            front_face: self.front_face,
            cull_mode,
            unclipped_depth: self.unclipped_depth,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthStencilDesc {
    pub format: TextureFormat,
    pub depth_write_enabled: Option<bool>,
    pub depth_compare: Option<CompareFunction>,
    #[serde(default)]
    pub stencil_front: StencilFaceDesc,
    #[serde(default)]
    pub stencil_back: StencilFaceDesc,
    #[serde(default = "all_bits")]
    pub stencil_read_mask: u32,
    #[serde(default = "all_bits")]
    pub stencil_write_mask: u32,
    #[serde(default)]
    pub depth_bias: i32,
    #[serde(default)]
    pub depth_bias_slope_scale: f32,
    #[serde(default)]
    pub depth_bias_clamp: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StencilFaceDesc {
    #[serde(default = "always")]
    pub compare: CompareFunction,
    #[serde(default = "keep")]
    pub fail_op: StencilOperation,
    #[serde(default = "keep")]
    pub depth_fail_op: StencilOperation,
    #[serde(default = "keep")]
    pub pass_op: StencilOperation,
}

impl Default for StencilFaceDesc {
    fn default() -> Self {
        Self { compare: always(), fail_op: keep(), depth_fail_op: keep(), pass_op: keep() }
    }
}

fn always() -> CompareFunction {
    CompareFunction::Always
}
fn keep() -> StencilOperation {
    StencilOperation::Keep
}

impl StencilFaceDesc {
    fn wgpu(&self) -> wgpu::StencilFaceState {
        wgpu::StencilFaceState { compare: self.compare, fail_op: self.fail_op, depth_fail_op: self.depth_fail_op, pass_op: self.pass_op }
    }
}

impl DepthStencilDesc {
    pub fn wgpu(&self) -> wgpu::DepthStencilState {
        wgpu::DepthStencilState {
            format: self.format,
            depth_write_enabled: self.depth_write_enabled,
            depth_compare: self.depth_compare,
            stencil: wgpu::StencilState {
                front: self.stencil_front.wgpu(),
                back: self.stencil_back.wgpu(),
                read_mask: self.stencil_read_mask,
                write_mask: self.stencil_write_mask,
            },
            bias: wgpu::DepthBiasState { constant: self.depth_bias, slope_scale: self.depth_bias_slope_scale, clamp: self.depth_bias_clamp },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultisampleDesc {
    #[serde(default = "one")]
    pub count: u32,
    #[serde(default = "all_bits")]
    pub mask: u32,
    #[serde(default)]
    pub alpha_to_coverage_enabled: bool,
}

impl Default for MultisampleDesc {
    fn default() -> Self {
        Self { count: 1, mask: u32::MAX, alpha_to_coverage_enabled: false }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentDesc {
    #[serde(flatten)]
    pub stage: Stage,
    pub targets: Vec<Option<ColorTargetDesc>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorTargetDesc {
    pub format: TextureFormat,
    pub blend: Option<BlendDesc>,
    #[serde(default = "write_all")]
    pub write_mask: u32,
}

fn write_all() -> u32 {
    0xf
}

#[derive(Deserialize)]
pub struct BlendDesc {
    pub color: BlendComponentDesc,
    pub alpha: BlendComponentDesc,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendComponentDesc {
    #[serde(default = "add")]
    pub operation: BlendOperation,
    #[serde(default = "factor_one")]
    pub src_factor: BlendFactor,
    #[serde(default = "factor_zero")]
    pub dst_factor: BlendFactor,
}

fn add() -> BlendOperation {
    BlendOperation::Add
}
fn factor_one() -> BlendFactor {
    BlendFactor::One
}
fn factor_zero() -> BlendFactor {
    BlendFactor::Zero
}

impl BlendComponentDesc {
    fn wgpu(&self) -> wgpu::BlendComponent {
        wgpu::BlendComponent { src_factor: self.src_factor, dst_factor: self.dst_factor, operation: self.operation }
    }
}

impl ColorTargetDesc {
    pub fn wgpu(&self) -> wgpu::ColorTargetState {
        wgpu::ColorTargetState {
            format: self.format,
            blend: self.blend.as_ref().map(|b| wgpu::BlendState { color: b.color.wgpu(), alpha: b.alpha.wgpu() }),
            write_mask: wgpu::ColorWrites::from_bits_truncate(self.write_mask),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuerySetDesc {
    pub label: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BufferCopy {
    pub buffer: u32,
    #[serde(default)]
    pub offset: u64,
    pub bytes_per_row: Option<u32>,
    pub rows_per_image: Option<u32>,
}

impl BufferCopy {
    pub fn layout(&self) -> wgpu::TexelCopyBufferLayout {
        wgpu::TexelCopyBufferLayout { offset: self.offset, bytes_per_row: self.bytes_per_row, rows_per_image: self.rows_per_image }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextureCopy {
    pub texture: u32,
    #[serde(default)]
    pub mip_level: u32,
    #[serde(default)]
    pub origin: Origin,
    #[serde(default = "aspect_all")]
    pub aspect: TextureAspect,
}

impl TextureCopy {
    pub fn wgpu<'a>(&self, texture: &'a wgpu::Texture) -> wgpu::TexelCopyTextureInfo<'a> {
        wgpu::TexelCopyTextureInfo {
            texture,
            mip_level: self.mip_level,
            origin: wgpu::Origin3d { x: self.origin.x, y: self.origin.y, z: self.origin.z },
            aspect: self.aspect,
        }
    }
}

#[derive(Deserialize)]
pub struct CopyBufferToTexture {
    pub source: BufferCopy,
    pub destination: TextureCopy,
    pub size: Extent,
}

#[derive(Deserialize)]
pub struct CopyTextureToBuffer {
    pub source: TextureCopy,
    pub destination: BufferCopy,
    pub size: Extent,
}

#[derive(Deserialize)]
pub struct CopyTextureToTexture {
    pub source: TextureCopy,
    pub destination: TextureCopy,
    pub size: Extent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataLayout {
    #[serde(default)]
    pub offset: u64,
    pub bytes_per_row: Option<u32>,
    pub rows_per_image: Option<u32>,
}

#[derive(Deserialize)]
pub struct WriteTexture {
    pub destination: TextureCopy,
    pub layout: DataLayout,
    pub size: Extent,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderPassDesc {
    pub label: Option<String>,
    pub color_attachments: Vec<Option<ColorAttachmentDesc>>,
    pub depth_stencil_attachment: Option<DepthStencilAttachmentDesc>,
    pub occlusion_query_set: Option<u32>,
    pub timestamp_writes: Option<TimestampWritesDesc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorAttachmentDesc {
    pub view: u32,
    pub depth_slice: Option<u32>,
    pub resolve_target: Option<u32>,
    #[serde(default)]
    pub clear_value: [f64; 4],
    pub load_op: String,
    pub store_op: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DepthStencilAttachmentDesc {
    pub view: u32,
    pub depth_clear_value: Option<f32>,
    pub depth_load_op: Option<String>,
    pub depth_store_op: Option<String>,
    #[serde(default)]
    pub depth_read_only: bool,
    #[serde(default)]
    pub stencil_clear_value: u32,
    pub stencil_load_op: Option<String>,
    pub stencil_store_op: Option<String>,
    #[serde(default)]
    pub stencil_read_only: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimestampWritesDesc {
    pub query_set: u32,
    pub beginning_of_pass_write_index: Option<u32>,
    pub end_of_pass_write_index: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputePassDesc {
    pub label: Option<String>,
    pub timestamp_writes: Option<TimestampWritesDesc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderBundleDesc {
    pub label: Option<String>,
    pub color_formats: Vec<Option<TextureFormat>>,
    pub depth_stencil_format: Option<TextureFormat>,
    #[serde(default = "one")]
    pub sample_count: u32,
    #[serde(default)]
    pub depth_read_only: bool,
    #[serde(default)]
    pub stencil_read_only: bool,
}

pub fn ops<V: Copy>(load: Option<&str>, store: Option<&str>, clear: V, read_only: bool) -> Result<Option<wgpu::Operations<V>>, String> {
    if read_only {
        return Ok(None);
    }
    let (Some(load), Some(store)) = (load, store) else { return Ok(None) };
    let load = match load {
        "clear" => wgpu::LoadOp::Clear(clear),
        "load" => wgpu::LoadOp::Load,
        other => return Err(format!("TypeError: '{other}' is not a GPULoadOp")),
    };
    let store = match store {
        "store" => wgpu::StoreOp::Store,
        "discard" => wgpu::StoreOp::Discard,
        other => return Err(format!("TypeError: '{other}' is not a GPUStoreOp")),
    };
    Ok(Some(wgpu::Operations { load, store }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasConfig {
    pub format: TextureFormat,
    #[serde(default = "render_attachment")]
    pub usage: u32,
    #[serde(default = "opaque")]
    pub alpha_mode: String,
    #[serde(default)]
    pub view_formats: Vec<TextureFormat>,
}

fn render_attachment() -> u32 {
    wgpu::TextureUsages::RENDER_ATTACHMENT.bits()
}
fn opaque() -> String {
    "opaque".into()
}
