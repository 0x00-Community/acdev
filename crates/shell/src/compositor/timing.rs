use std::time::Duration;

use smithay::backend::renderer::element::{RenderElementStates, default_primary_scanout_output_compare};
use smithay::desktop::layer_map_for_output;
use smithay::desktop::utils::{
    OutputPresentationFeedback, send_frames_surface_tree, surface_presentation_feedback_flags_from_states, surface_primary_scanout_output,
    update_surface_primary_scanout_output,
};
use smithay::input::pointer::CursorImageStatus;
use smithay::reexports::calloop::RegistrationToken;
use smithay::reexports::calloop::timer::{TimeoutAction, Timer};
use smithay::reexports::wayland_protocols::wp::presentation_time::server::wp_presentation_feedback::Kind;
use smithay::reexports::wayland_server::protocol::wl_surface::WlSurface;
use smithay::reexports::wayland_server::{Client, DisplayHandle, Resource};
use smithay::utils::{Clock, Monotonic, Time};
use smithay::wayland::commit_timing::{CommitTimerBarrierStateUserData, CommitTimingManagerState};
use smithay::wayland::compositor::{CompositorHandler, SurfaceData, TraversalAction, with_surface_tree_downward};
use smithay::wayland::fifo::{FifoBarrierCachedState, FifoManagerState};
use smithay::wayland::presentation::{PresentationState, Refresh};
use smithay::{delegate_commit_timing, delegate_fifo, delegate_presentation};

use super::Compositor;

const CLOCK_MONOTONIC: u32 = 1;

pub struct Timing {
    pub clock: Clock<Monotonic>,
    pub pending: Option<OutputPresentationFeedback>,
    _presentation: PresentationState,
    _fifo: FifoManagerState,
    _commit_timing: CommitTimingManagerState,
}

impl Timing {
    pub fn new(dh: &DisplayHandle) -> Self {
        Self {
            clock: Clock::new(),
            pending: None,
            _presentation: PresentationState::new::<Compositor>(dh, CLOCK_MONOTONIC),
            _fifo: FifoManagerState::new::<Compositor>(dh),
            _commit_timing: CommitTimingManagerState::new::<Compositor>(dh),
        }
    }
}

type TimerSlot = fn(&mut Compositor) -> &mut Option<RegistrationToken>;

impl Compositor {
    pub fn after(&mut self, slot: TimerSlot, dur: Duration, mut f: impl FnMut(&mut Self) + 'static) -> bool {
        if slot(self).is_some() {
            return true;
        }
        let inserted = self.loop_handle.insert_source(Timer::from_duration(dur), move |_, _, state| {
            *slot(state) = None;
            f(state);
            TimeoutAction::Drop
        });
        *slot(self) = inserted.inspect_err(|e| log::warn!("定时器: {e}")).ok();
        slot(self).is_some()
    }

    pub fn cancel(&mut self, slot: TimerSlot) {
        if let Some(token) = slot(self).take() {
            self.loop_handle.remove(token);
        }
    }

    pub fn frame_duration(&self) -> Duration {
        let refresh = self.backend.output.current_mode().map_or(60_000, |m| m.refresh);
        Duration::from_secs_f64(1000.0 / f64::from(refresh.max(1)))
    }

    pub fn pre_repaint(&mut self, frame_target: Time<Monotonic>) {
        let mut clients = Vec::new();
        let mut signal = |surface: &WlSurface, states: &SurfaceData| {
            if let Some(timer) = states.data_map.get::<CommitTimerBarrierStateUserData>() {
                timer.lock().expect("commit timer 锁").signal_until(frame_target);
                Self::note_client(&mut clients, surface);
            }
        };
        for window in self.space.elements() {
            window.with_surfaces(&mut signal);
        }
        for root in self.unmanaged_surfaces() {
            Self::each_surface(&root, &mut signal);
        }
        self.blockers_cleared(clients);
    }

    fn unmanaged_surfaces(&self) -> Vec<WlSurface> {
        let mut roots = Vec::new();
        for output in self.space.outputs() {
            roots.extend(layer_map_for_output(output).layers().map(|l| l.wl_surface().clone()));
        }
        if let Some(surfaces) = &self.lock.surfaces {
            roots.extend(surfaces.values().map(|s| s.wl_surface().clone()));
        }
        if let CursorImageStatus::Surface(surface) = &self.cursor.status {
            roots.push(surface.clone());
        }
        roots.extend(self.drag_icon());
        roots
    }

    fn each_surface(root: &WlSurface, mut f: impl FnMut(&WlSurface, &SurfaceData)) {
        with_surface_tree_downward(root, (), |_, _, _| TraversalAction::DoChildren(()), |surface, states, _| f(surface, states), |_, _, _| true);
    }

    fn unmanaged_frames(&self, output: &smithay::output::Output, now: Duration) {
        for root in self.unmanaged_surfaces() {
            send_frames_surface_tree(&root, output, now, Some(Duration::from_secs(1)), |_, _| Some(output.clone()));
        }
    }

    fn note_client(clients: &mut Vec<Client>, surface: &WlSurface) {
        if let Some(client) = surface.client().filter(|c| !clients.contains(c)) {
            clients.push(client);
        }
    }

    fn blockers_cleared(&mut self, clients: Vec<Client>) {
        let dh = self.display.clone();
        for client in clients {
            self.client_compositor_state(&client).blocker_cleared(self, &dh);
        }
    }

    pub fn post_repaint(&mut self, states: &RenderElementStates, output: &smithay::output::Output) -> OutputPresentationFeedback {
        let output = output.clone();
        let now = self.start.elapsed();
        for window in self.space.elements() {
            window.with_surfaces(|surface, surface_states| {
                update_surface_primary_scanout_output(surface, &output, surface_states, states, default_primary_scanout_output_compare);
            });
            window.send_frame(&output, now, Some(Duration::from_secs(1)), surface_primary_scanout_output);
        }
        self.unmanaged_frames(&output, now);
        let mut feedback = OutputPresentationFeedback::new(&output);
        for window in self.space.elements() {
            window.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
                surface_presentation_feedback_flags_from_states(surface, states)
            });
        }
        feedback
    }

    pub fn frames_without_repaint(&mut self, output: &smithay::output::Output) {
        let now = self.start.elapsed();
        for window in self.space.elements() {
            window.send_frame(output, now, Some(Duration::from_secs(1)), |_, _| Some(output.clone()));
        }
        self.unmanaged_frames(output, now);
    }

    pub fn on_vblank(&mut self, feedback: Option<OutputPresentationFeedback>) {
        self.milestone("第一次 vblank");
        self.backend.presenting = false;
        self.presented(feedback);
        self.settle_overdue();
    }

    pub(super) fn feedback_presented(&self, mut feedback: OutputPresentationFeedback) {
        feedback.presented(self.timing.clock.now(), Refresh::fixed(self.frame_duration()), 0, Kind::Vsync);
    }

    fn presented(&mut self, feedback: Option<OutputPresentationFeedback>) {
        if let Some(feedback) = feedback {
            self.feedback_presented(feedback);
        }
        let mut clients = Vec::new();
        let mut waiting = false;
        let mut signal = |surface: &WlSurface, surface_states: &SurfaceData| {
            let barrier = surface_states.cached_state.get::<FifoBarrierCachedState>().current().barrier.take();
            if let Some(barrier) = barrier {
                barrier.signal();
                waiting = true;
                Self::note_client(&mut clients, surface);
            }
            waiting |=
                surface_states.data_map.get::<CommitTimerBarrierStateUserData>().is_some_and(|t| t.lock().expect("commit timer 锁").next_deadline().is_some());
        };
        for window in self.space.elements() {
            window.with_surfaces(&mut signal);
        }
        for root in self.unmanaged_surfaces() {
            Self::each_surface(&root, &mut signal);
        }
        self.blockers_cleared(clients);
        if waiting {
            self.backend.damaged();
        }
    }
}

delegate_presentation!(Compositor);
delegate_fifo!(Compositor);
delegate_commit_timing!(Compositor);
