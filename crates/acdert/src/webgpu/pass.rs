use acde_gpu::wgpu;
use wgpu::util::RenderEncoder;

use super::{Id, Kind, State, desc, report};

pub fn commands(args: &v8::FunctionCallbackArguments, i: i32, length: u32) -> Vec<f64> {
    let Ok(array) = v8::Local::<v8::Float64Array>::try_from(args.get(i)) else { return Vec::new() };
    let length = (length as usize).min(array.length());
    let mut out = vec![0.0; length];
    let bytes = unsafe { std::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, length * 8) };
    array.copy_contents(bytes);
    out
}

pub fn strings(scope: &mut v8::PinScope, args: &v8::FunctionCallbackArguments, i: i32) -> Vec<String> {
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(i)) else { return Vec::new() };
    (0..list.length()).map(|k| list.get_index(scope, k).map(|v| v.to_rust_string_lossy(scope)).unwrap_or_default()).collect()
}

struct Reader<'a> {
    commands: &'a [f64],
    at: usize,
}

impl Reader<'_> {
    fn next(&mut self) -> Option<f64> {
        let value = self.commands.get(self.at).copied();
        self.at += 1;
        value
    }

    fn u32(&mut self) -> u32 {
        self.next().filter(|n| *n >= 0.0).map_or(0, |n| n as u32)
    }

    fn u64(&mut self) -> u64 {
        self.next().filter(|n| *n >= 0.0).map_or(0, |n| n as u64)
    }

    fn f32(&mut self) -> f32 {
        self.next().unwrap_or(0.0) as f32
    }

    fn size(&mut self) -> Option<wgpu::BufferSize> {
        self.next().filter(|n| *n >= 0.0).and_then(|n| wgpu::BufferSize::new(n as u64))
    }

    fn done(&self) -> bool {
        self.at >= self.commands.len()
    }
}

fn common<'a>(s: &'a State, device: Id, op: u32, r: &mut Reader, pass: &mut impl RenderEncoder<'a>) -> bool {
    match op {
        1 => {
            if let Some(p) = s.render_pipeline(device, r.u32()) {
                pass.set_pipeline(p);
            }
        }
        2 => {
            let (index, id, n) = (r.u32(), r.u32(), r.u32());
            let offsets: Vec<u32> = (0..n).map(|_| r.u32()).collect();
            if id == 0 {
                pass.set_bind_group(index, None, &[]);
            } else if let Some(g) = s.bind_group(device, id) {
                pass.set_bind_group(index, Some(&g.group), &offsets);
            }
        }
        3 => {
            let (slot, id, offset, size) = (r.u32(), r.u32(), r.u64(), r.size());
            if id == 0 {
                pass.set_vertex_buffer(slot, None);
            } else if let Some(b) = s.buffer(device, id) {
                let end = size.map_or(b.buffer.size(), |size| offset.saturating_add(size.get()));
                if offset > end || end > b.buffer.size() {
                    report(device, Kind::Validation, format!("setVertexBuffer: range {offset}..{end} is outside the buffer"));
                } else {
                    pass.set_vertex_buffer(slot, Some(b.buffer.slice(offset..end)));
                }
            }
        }
        4 => {
            let (id, format, offset, size) = (r.u32(), r.u32(), r.u64(), r.size());
            let format = if format == 1 { wgpu::IndexFormat::Uint32 } else { wgpu::IndexFormat::Uint16 };
            if let Some(b) = s.buffer(device, id) {
                let end = size.map_or(b.buffer.size(), |size| offset.saturating_add(size.get()));
                if offset > end || end > b.buffer.size() {
                    report(device, Kind::Validation, format!("setIndexBuffer: range {offset}..{end} is outside the buffer"));
                } else {
                    pass.set_index_buffer(b.buffer.slice(offset..end), format);
                }
            }
        }
        5 => {
            let (vertices, instances, first, first_instance) = (r.u32(), r.u32(), r.u32(), r.u32());
            pass.draw(first..first.saturating_add(vertices), first_instance..first_instance.saturating_add(instances));
        }
        6 => {
            let (indices, instances, first, base) = (r.u32(), r.u32(), r.u32(), r.next().unwrap_or(0.0) as i32);
            let first_instance = r.u32();
            pass.draw_indexed(first..first.saturating_add(indices), base, first_instance..first_instance.saturating_add(instances));
        }
        7 | 8 => {
            let (id, offset) = (r.u32(), r.u64());
            if let Some(b) = s.buffer(device, id) {
                if op == 7 {
                    pass.draw_indirect(&b.buffer, offset);
                } else {
                    pass.draw_indexed_indirect(&b.buffer, offset);
                }
            }
        }
        _ => return false,
    }
    true
}

fn touch_bind_groups(s: &mut State, encoder: &mut wgpu::CommandEncoder, commands: &[f64]) {
    let mut r = Reader { commands, at: 0 };
    let mut textures = Vec::new();
    while let Some(op) = r.next() {
        match op as u32 {
            2 => {
                let (_, id, n) = (r.u32(), r.u32(), r.u32());
                r.at += n as usize;
                if let Some(super::Obj::BindGroup(g)) = s.objects.get(&id) {
                    textures.extend_from_slice(&g.canvas_textures);
                }
            }
            op => r.at += operands(op, &r),
        }
    }
    for texture in textures {
        super::canvas::touch(s, encoder, texture, false);
    }
}

fn operands(op: u32, r: &Reader) -> usize {
    match op {
        1 | 12 | 13 | 16 | 18 => 1,
        7 | 8 | 20 => 2,
        19 => 3,
        3 | 4 | 5 | 10 | 11 => 4,
        6 => 5,
        9 => 6,
        15 => 1 + r.commands.get(r.at).copied().unwrap_or(0.0).max(0.0) as usize,
        _ => 0,
    }
}

pub fn render(s: &mut State, encoder: &mut wgpu::CommandEncoder, device: Id, d: &desc::RenderPassDesc, commands: &[f64], strings: &[String]) -> Result<(), String> {
    for attachment in d.color_attachments.iter().flatten() {
        if let Some(super::Obj::View(v)) = s.objects.get(&attachment.view) {
            let texture = v.texture;
            super::canvas::touch(s, encoder, texture, attachment.load_op == "clear");
        }
        if let Some(super::Obj::View(v)) = attachment.resolve_target.and_then(|id| s.objects.get(&id)) {
            let texture = v.texture;
            super::canvas::touch(s, encoder, texture, true);
        }
    }
    touch_bind_groups(s, encoder, commands);
    let s = &*s;
    let mut colors = Vec::with_capacity(d.color_attachments.len());
    for attachment in &d.color_attachments {
        let Some(a) = attachment else {
            colors.push(None);
            continue;
        };
        let Some(view) = s.view(device, a.view) else { return Ok(()) };
        let resolve_target = match a.resolve_target {
            Some(id) => match s.view(device, id) {
                Some(v) => Some(&v.view),
                None => return Ok(()),
            },
            None => None,
        };
        let [r, g, b, alpha] = a.clear_value;
        let ops = desc::ops(Some(&a.load_op), Some(&a.store_op), wgpu::Color { r, g, b, a: alpha }, false)?.ok_or("TypeError: a color attachment needs loadOp and storeOp")?;
        colors.push(Some(wgpu::RenderPassColorAttachment { view: &view.view, depth_slice: a.depth_slice, resolve_target, ops }));
    }
    let depth_stencil = match &d.depth_stencil_attachment {
        Some(a) => {
            let Some(view) = s.view(device, a.view) else { return Ok(()) };
            Some(wgpu::RenderPassDepthStencilAttachment {
                view: &view.view,
                depth_ops: desc::ops(a.depth_load_op.as_deref(), a.depth_store_op.as_deref(), a.depth_clear_value.unwrap_or(0.0), a.depth_read_only)?,
                stencil_ops: desc::ops(a.stencil_load_op.as_deref(), a.stencil_store_op.as_deref(), a.stencil_clear_value, a.stencil_read_only)?,
            })
        }
        None => None,
    };
    let occlusion_query_set = match d.occlusion_query_set {
        Some(id) => match s.query_set(device, id) {
            Some(q) => Some(&q.set),
            None => return Ok(()),
        },
        None => None,
    };
    let timestamp_writes = match &d.timestamp_writes {
        Some(t) => match s.query_set(device, t.query_set) {
            Some(q) => Some(wgpu::RenderPassTimestampWrites {
                query_set: &q.set,
                beginning_of_pass_write_index: t.beginning_of_pass_write_index,
                end_of_pass_write_index: t.end_of_pass_write_index,
            }),
            None => return Ok(()),
        },
        None => None,
    };
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
        label: desc::label(&d.label),
        color_attachments: &colors,
        depth_stencil_attachment: depth_stencil,
        timestamp_writes,
        occlusion_query_set,
        multiview_mask: None,
    });
    let mut r = Reader { commands, at: 0 };
    while !r.done() {
        let op = r.u32();
        if common(s, device, op, &mut r, &mut pass) {
            continue;
        }
        match op {
            9 => {
                let (x, y, w, h, min, max) = (r.f32(), r.f32(), r.f32(), r.f32(), r.f32(), r.f32());
                pass.set_viewport(x, y, w, h, min, max);
            }
            10 => {
                let (x, y, w, h) = (r.u32(), r.u32(), r.u32(), r.u32());
                pass.set_scissor_rect(x, y, w, h);
            }
            11 => {
                let (red, g, b, a) = (r.next().unwrap_or(0.0), r.next().unwrap_or(0.0), r.next().unwrap_or(0.0), r.next().unwrap_or(0.0));
                pass.set_blend_constant(wgpu::Color { r: red, g, b, a });
            }
            12 => pass.set_stencil_reference(r.u32()),
            13 => pass.begin_occlusion_query(r.u32()),
            14 => pass.end_occlusion_query(),
            15 => {
                let n = r.u32();
                let bundles: Vec<&wgpu::RenderBundle> = (0..n).filter_map(|_| s.render_bundle(device, r.u32())).collect();
                pass.execute_bundles(bundles);
            }
            16 => pass.push_debug_group(strings.get(r.u32() as usize).map_or("", String::as_str)),
            17 => pass.pop_debug_group(),
            18 => pass.insert_debug_marker(strings.get(r.u32() as usize).map_or("", String::as_str)),
            other => {
                report(device, Kind::Validation, format!("render pass: unknown command {other}"));
                break;
            }
        }
    }
    Ok(())
}

pub fn compute(s: &mut State, encoder: &mut wgpu::CommandEncoder, device: Id, d: &desc::ComputePassDesc, commands: &[f64], strings: &[String]) {
    touch_bind_groups(s, encoder, commands);
    let s = &*s;
    let timestamp_writes = match &d.timestamp_writes {
        Some(t) => match s.query_set(device, t.query_set) {
            Some(q) => Some(wgpu::ComputePassTimestampWrites {
                query_set: &q.set,
                beginning_of_pass_write_index: t.beginning_of_pass_write_index,
                end_of_pass_write_index: t.end_of_pass_write_index,
            }),
            None => return,
        },
        None => None,
    };
    let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: desc::label(&d.label), timestamp_writes });
    let mut r = Reader { commands, at: 0 };
    while !r.done() {
        match r.u32() {
            1 => {
                if let Some(p) = s.compute_pipeline(device, r.u32()) {
                    pass.set_pipeline(p);
                }
            }
            2 => {
                let (index, id, n) = (r.u32(), r.u32(), r.u32());
                let offsets: Vec<u32> = (0..n).map(|_| r.u32()).collect();
                if id == 0 {
                    pass.set_bind_group(index, None, &[]);
                } else if let Some(g) = s.bind_group(device, id) {
                    pass.set_bind_group(index, Some(&g.group), &offsets);
                }
            }
            19 => {
                let (x, y, z) = (r.u32(), r.u32(), r.u32());
                pass.dispatch_workgroups(x, y, z);
            }
            20 => {
                let (id, offset) = (r.u32(), r.u64());
                if let Some(b) = s.buffer(device, id) {
                    pass.dispatch_workgroups_indirect(&b.buffer, offset);
                }
            }
            16 => pass.push_debug_group(strings.get(r.u32() as usize).map_or("", String::as_str)),
            17 => pass.pop_debug_group(),
            18 => pass.insert_debug_marker(strings.get(r.u32() as usize).map_or("", String::as_str)),
            other => {
                report(device, Kind::Validation, format!("compute pass: unknown command {other}"));
                break;
            }
        }
    }
}

pub fn bundle(s: &State, gpu: &acde_paint::Gpu, device: Id, d: &desc::RenderBundleDesc, commands: &[f64], strings: &[String]) -> Option<wgpu::RenderBundle> {
    let mut encoder = gpu.device.create_render_bundle_encoder(&wgpu::RenderBundleEncoderDescriptor {
        label: desc::label(&d.label),
        color_formats: &d.color_formats,
        depth_stencil: d.depth_stencil_format.map(|format| wgpu::RenderBundleDepthStencil { format, depth_read_only: d.depth_read_only, stencil_read_only: d.stencil_read_only }),
        sample_count: d.sample_count,
        multiview: None,
    });
    let mut r = Reader { commands, at: 0 };
    while !r.done() {
        let op = r.u32();
        if common(s, device, op, &mut r, &mut encoder) {
            continue;
        }
        match op {
            16 | 18 => _ = strings.get(r.u32() as usize),
            17 => {}
            other => {
                report(device, Kind::Validation, format!("render bundle: unknown command {other}"));
                return None;
            }
        }
    }
    Some(encoder.finish(&wgpu::RenderBundleDescriptor { label: desc::label(&d.label) }))
}
