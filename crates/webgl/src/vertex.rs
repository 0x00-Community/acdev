use crate::consts::*;
use crate::context::Context;
use crate::objects::*;
use crate::state::Generic;

impl Context {
    pub fn create_vertex_array(&mut self) -> Id {
        self.add(Object::VertexArray(VertexArray::new()))
    }

    pub fn delete_vertex_array(&mut self, id: Id) {
        if self.objects.get(&id).and_then(Object::vertex_array).is_none() {
            return;
        }
        if self.state.vertex_array == Some(id) {
            self.state.vertex_array = None;
        }
        self.objects.remove(&id);
    }

    pub fn bind_vertex_array(&mut self, id: Option<Id>) {
        if let Some(id) = id {
            match self.objects.get_mut(&id).and_then(Object::vertex_array_mut) {
                Some(v) => v.bound_once = true,
                None => return self.error(INVALID_OPERATION),
            }
        }
        self.state.vertex_array = id;
    }

    pub fn is_vertex_array(&self, id: Id) -> bool {
        self.objects.get(&id).and_then(Object::vertex_array).is_some_and(|v| v.bound_once)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn vertex_attrib_pointer(&mut self, index: u32, size: i32, ty: u32, normalized: bool, stride: i32, offset: i64, integer: bool) {
        if index >= self.limits.attributes {
            return self.error(INVALID_VALUE);
        }
        let packed = matches!(ty, INT_2_10_10_10_REV | UNSIGNED_INT_2_10_10_10_REV);
        let ok_type = match ty {
            BYTE | UNSIGNED_BYTE | SHORT | UNSIGNED_SHORT => true,
            FLOAT => !integer,
            INT | UNSIGNED_INT => self.webgl2,
            HALF_FLOAT if self.webgl2 => !integer,
            HALF_FLOAT_OES => !integer && !self.webgl2 && self.extension("OES_texture_half_float"),
            INT_2_10_10_10_REV | UNSIGNED_INT_2_10_10_10_REV => self.webgl2 && !integer,
            _ => false,
        };
        if !ok_type {
            return self.error(INVALID_ENUM);
        }
        if !(1..=4).contains(&size) || !(0..=255).contains(&stride) || offset < 0 {
            return self.error(INVALID_VALUE);
        }
        if packed && size != 4 {
            return self.error(INVALID_OPERATION);
        }
        let type_size = match ty {
            BYTE | UNSIGNED_BYTE => 1,
            SHORT | UNSIGNED_SHORT | HALF_FLOAT | HALF_FLOAT_OES => 2,
            _ => 4,
        };
        if offset % type_size != 0 || stride as i64 % type_size != 0 {
            return self.error(INVALID_OPERATION);
        }
        let buffer = self.state.array_buffer;
        if buffer.is_none() && offset != 0 {
            return self.error(INVALID_OPERATION);
        }
        let divisor = self.vao().attribs[index as usize].divisor;
        let enabled = self.vao().attribs[index as usize].enabled;
        self.vao_mut().attribs[index as usize] = Attrib {
            enabled,
            buffer,
            size: size as u32,
            ty,
            normalized: normalized && !integer,
            integer,
            stride: stride as u32,
            offset: offset as u64,
            divisor,
        };
    }

    pub fn enable_vertex_attrib(&mut self, index: u32, on: bool) {
        if index >= self.limits.attributes {
            return self.error(INVALID_VALUE);
        }
        self.vao_mut().attribs[index as usize].enabled = on;
    }

    pub fn vertex_attrib_divisor(&mut self, index: u32, divisor: u32) {
        if index >= self.limits.attributes {
            return self.error(INVALID_VALUE);
        }
        self.vao_mut().attribs[index as usize].divisor = divisor;
    }

    pub fn vertex_attrib(&mut self, index: u32, value: Generic) {
        if index >= self.limits.attributes {
            return self.error(INVALID_VALUE);
        }
        self.state.generic[index as usize] = value;
    }

    pub fn vertex_attrib_state(&mut self, index: u32) -> Option<(Attrib, Generic)> {
        if index >= self.limits.attributes {
            self.error(INVALID_VALUE);
            return None;
        }
        Some((self.vao().attribs[index as usize], self.state.generic[index as usize]))
    }
}
