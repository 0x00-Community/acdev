use crate::consts::*;
use crate::context::Context;
use crate::objects::*;

impl Context {
    pub fn create_query(&mut self) -> Id {
        self.add(Object::Query(Query { target: 0, result: None, pending: None, available_after: 0 }))
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
        if self.state.queries[slot].1.is_some() {
            return self.error(INVALID_OPERATION);
        }
        let Some(q) = self.objects.get_mut(&id).and_then(Object::query_mut) else { return self.error(INVALID_OPERATION) };
        if q.target != 0 && q.target != target {
            return self.error(INVALID_OPERATION);
        }
        q.target = target;
        q.result = None;
        self.state.queries[slot].1 = Some(id);
    }

    pub fn end_query(&mut self, target: u32) {
        let Some(slot) = self.state.queries.iter().position(|q| q.0 == target) else { return self.error(INVALID_ENUM) };
        let Some(id) = self.state.queries[slot].1.take() else { return self.error(INVALID_OPERATION) };
        let drawn = self.recorder.pass.as_ref().is_some_and(|p| !p.draws.is_empty()) || self.recorder.encoder.is_some();
        let generation = self.generation;
        if let Some(q) = self.objects.get_mut(&id).and_then(Object::query_mut) {
            q.result = Some(u64::from(drawn || target == TRANSFORM_FEEDBACK_PRIMITIVES_WRITTEN));
            q.available_after = generation;
        }
    }

    pub fn query_result(&mut self, id: Id, name: u32) -> Option<u64> {
        let generation = self.generation;
        let q = self.objects.get(&id).and_then(Object::query)?;
        if self.state.queries.iter().any(|s| s.1 == Some(id)) {
            self.error(INVALID_OPERATION);
            return None;
        }
        let available = q.result.is_some() && generation > q.available_after;
        match name {
            QUERY_RESULT_AVAILABLE => Some(u64::from(available)),
            QUERY_RESULT => Some(if available { q.result.unwrap_or(0) } else { 0 }),
            _ => {
                self.error(INVALID_ENUM);
                None
            }
        }
    }

    pub fn fence_sync(&mut self) -> Id {
        let index = self.submit();
        self.add(Object::Sync(Sync { submission: index, signaled: false }))
    }

    pub fn delete_sync(&mut self, id: Id) {
        self.objects.remove(&id);
    }

    pub fn sync_status(&mut self, id: Id) -> Option<bool> {
        let s = self.objects.get_mut(&id).and_then(Object::sync_mut)?;
        if !s.signaled {
            match &s.submission {
                None => s.signaled = true,
                Some(_) => {
                    let _ = self.gpu.device.poll(wgpu::PollType::Poll);
                    let s = self.objects.get_mut(&id).and_then(Object::sync_mut)?;
                    s.signaled = true;
                }
            }
        }
        Some(self.objects.get(&id).and_then(Object::sync).is_some_and(|s| s.signaled))
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
        log::warn!("webgl: transform feedback is not supported");
        self.error(INVALID_OPERATION);
    }
}
