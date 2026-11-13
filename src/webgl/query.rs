use std::sync::atomic::Ordering;

use crate::webgl::consts::*;
use crate::webgl::context::Context;
use crate::webgl::objects::*;

impl Context {
    pub fn create_query(&mut self) -> Id {
        self.add(Object::Query(Query { target: 0, active: false, slots: Vec::new(), result: None }))
    }

    pub fn delete_query(&mut self, id: Id) {
        for q in &mut self.state.queries {
            if q.1 == Some(id) {
                q.1 = None;
            }
        }
        self.objects.remove(&id);
    }

    pub fn begin_query(&mut self, target: u32, id: Id) {
        let Some(slot) = self.state.queries.iter().position(|q| q.0 == target) else { return self.error(INVALID_ENUM) };
        if target == TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN {
            return self.error(INVALID_OPERATION);
        }
        if self.state.queries[..2].iter().any(|q| q.1.is_some()) {
            return self.error(INVALID_OPERATION);
        }
        let Some(q) = self.objects.get_mut(&id).and_then(Object::query_mut) else { return self.error(INVALID_OPERATION) };
        if q.target != 0 && q.target != target {
            return self.error(INVALID_OPERATION);
        }
        q.target = target;
        q.active = true;
        q.slots.clear();
        q.result = None;
        self.state.queries[slot].1 = Some(id);
    }

    pub fn end_query(&mut self, target: u32) {
        let Some(slot) = self.state.queries.iter().position(|q| q.0 == target) else { return self.error(INVALID_ENUM) };
        let Some(id) = self.state.queries[slot].1.take() else { return self.error(INVALID_OPERATION) };
        if let Some(q) = self.objects.get_mut(&id).and_then(Object::query_mut) {
            q.active = false;
        }
    }

    pub fn query_result(&mut self, id: Id, name: u32) -> Option<u64> {
        if !matches!(name, QUERY_RESULT | QUERY_RESULT_AVAILABLE) {
            self.error(INVALID_ENUM);
            return None;
        }
        let q = self.objects.get(&id).and_then(Object::query)?;
        if q.active || q.target == 0 {
            self.error(INVALID_OPERATION);
            return None;
        }
        if q.result.is_none() {
            let unsubmitted = q.slots.iter().any(|(r, _)| {
                self.recorder.readbacks.iter().any(|p| std::rc::Rc::ptr_eq(p, r)) || self.recorder.pass.as_ref().is_some_and(|p| p.queries.contains(&id))
            });
            if !unsubmitted {
                let _ = self.gpu.device.poll(wgpu::PollType::Poll);
            }
            let q = self.objects.get(&id).and_then(Object::query)?;
            let ready = !unsubmitted && q.slots.iter().all(|(r, _)| r.state.load(Ordering::Acquire) != Readback::PENDING);
            if ready {
                let mut any = false;
                for (r, slot) in &q.slots {
                    if r.state.load(Ordering::Acquire) != Readback::MAPPED {
                        continue;
                    }
                    let at = u64::from(*slot) * 8;
                    if let Ok(view) = r.buffer.slice(at..at + 8).get_mapped_range() {
                        any |= u64::from_le_bytes(view[..8].try_into().unwrap_or_default()) != 0;
                    }
                }
                if let Some(q) = self.objects.get_mut(&id).and_then(Object::query_mut) {
                    q.result = Some(u64::from(any));
                    q.slots.clear();
                }
            }
        }
        let result = self.objects.get(&id).and_then(Object::query)?.result;
        Some(match name {
            QUERY_RESULT_AVAILABLE => u64::from(result.is_some()),
            _ => result.unwrap_or(0),
        })
    }

    pub fn fence_sync(&mut self) -> Id {
        self.submit();
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = done.clone();
        self.gpu.queue.on_submitted_work_done(move || flag.store(true, Ordering::Release));
        self.add(Object::Sync(Sync { done }))
    }

    pub fn delete_sync(&mut self, id: Id) {
        self.objects.remove(&id);
    }

    pub fn sync_status(&mut self, id: Id) -> Option<bool> {
        let done = self.objects.get(&id).and_then(Object::sync)?.done.clone();
        if !done.load(Ordering::Acquire) {
            let _ = self.gpu.device.poll(wgpu::PollType::Poll);
        }
        Some(done.load(Ordering::Acquire))
    }

    pub fn create_transform_feedback(&mut self) -> Id {
        self.add(Object::TransformFeedback(TransformFeedback { active: false, paused: false }))
    }

    pub fn delete_transform_feedback(&mut self, id: Id) {
        if self.state.transform_feedback == Some(id) {
            self.state.transform_feedback = None;
        }
        self.objects.remove(&id);
    }

    pub fn bind_transform_feedback(&mut self, id: Option<Id>) {
        if id.is_some_and(|id| self.objects.get(&id).and_then(Object::transform_feedback).is_none()) {
            return self.error(INVALID_OPERATION);
        }
        self.state.transform_feedback = id;
    }

    pub fn begin_transform_feedback(&mut self) {
        self.error(INVALID_OPERATION);
    }
}
