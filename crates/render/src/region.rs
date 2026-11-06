use acde_gpu::Scene;
use acde_gpu::RenderCommand;
use kurbo::{Affine, Rect, Shape};
use peniko::Compose;

use crate::commands::Commands;

const PAD: f64 = 2.0;

struct Open<'a> {
    push: (&'a RenderCommand, Affine),
    emitted: bool,
    keep_all: bool,
}

pub(crate) fn scene_for(commands: &Commands, draw: &[Rect], tolerance: f64, rect: Rect) -> Scene {
    let rect = rect.inflate(PAD, PAD);
    let mut out: Vec<RenderCommand> = Vec::new();
    let mut open: Vec<Open> = Vec::new();
    let mut skipping = 0usize;
    let emit = |open: &mut Vec<Open>, out: &mut Vec<RenderCommand>| {
        for layer in open.iter_mut().filter(|l| !l.emitted) {
            out.push(Commands::placed(layer.push.0, layer.push.1));
            layer.emitted = true;
        }
    };
    for (i, (command, t)) in commands.iter().enumerate() {
        match command {
            RenderCommand::PushLayer(_) | RenderCommand::PushClipLayer(_) => {
                if skipping > 0 {
                    skipping += 1;
                    continue;
                }
                let (clip, effect) = match command {
                    RenderCommand::PushLayer(l) => (
                        (t * l.transform).transform_rect_bbox(l.clip.bounding_box()),
                        (l.filter.is_some(), l.backdrop_filter.is_some() || l.blend.compose != Compose::SrcOver),
                    ),
                    RenderCommand::PushClipLayer(c) => {
                        ((t * c.transform).transform_rect_bbox(c.clip.bounding_box()), (false, false))
                    }
                    _ => unreachable!(),
                };
                if !clip.overlaps(rect) {
                    skipping = 1;
                    continue;
                }
                let (filter, visible_when_empty) = effect;
                let keep_all = open.last().is_some_and(|l| l.keep_all) || filter;
                open.push(Open { push: (command, t), emitted: false, keep_all });
                if keep_all || visible_when_empty {
                    emit(&mut open, &mut out);
                }
            }
            RenderCommand::PopLayer => {
                if skipping > 0 {
                    skipping -= 1;
                    continue;
                }
                if open.pop().is_some_and(|l| l.emitted) {
                    out.push(RenderCommand::PopLayer);
                }
            }
            _ => {
                if skipping > 0 {
                    continue;
                }
                let keep_all = open.last().is_some_and(|l| l.keep_all);
                if keep_all || draw.get(i).is_none_or(|r| r.overlaps(rect)) {
                    emit(&mut open, &mut out);
                    out.push(Commands::placed(command, t));
                }
            }
        }
    }
    Scene { tolerance, commands: out }
}
