use crate::model::Rect;

wire!("screen edge" ScreenEdge {
    Top = "top",
    Right = "right",
    Bottom = "bottom",
    Left = "left",
});

impl ScreenEdge {
    fn bit(self) -> u8 {
        1 << self as u32
    }

    pub fn touched(x: f64, y: f64, area: Rect, beyond: impl Fn(f64, f64) -> bool) -> u8 {
        let at = [
            (Self::Top, y < area.y + 1.0, (x, area.y - 1.0)),
            (Self::Right, x >= area.right() - 1.0, (area.right() + 1.0, y)),
            (Self::Bottom, y >= area.bottom() - 1.0, (x, area.bottom() + 1.0)),
            (Self::Left, x < area.x + 1.0, (area.x - 1.0, y)),
        ];
        at.into_iter().filter(|&(_, on, (bx, by))| on && !beyond(bx, by)).fold(0, |edges, (edge, ..)| edges | edge.bit())
    }

    pub fn changes(before: u8, after: u8) -> impl Iterator<Item = (ScreenEdge, bool)> {
        Self::ALL.iter().copied().filter(move |edge| (before ^ after) & edge.bit() != 0).map(move |edge| (edge, after & edge.bit() != 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edges_are_the_sides_the_pointer_cannot_pass() {
        let area = Rect::new(0.0, 0.0, 1920.0, 1080.0);
        let none = |_: f64, _: f64| false;
        assert_eq!(ScreenEdge::touched(500.0, 500.0, area, none), 0);
        assert_eq!(ScreenEdge::touched(500.0, 0.0, area, none), ScreenEdge::Top.bit());
        assert_eq!(ScreenEdge::touched(0.0, 1079.0, area, none), ScreenEdge::Left.bit() | ScreenEdge::Bottom.bit());
        assert_eq!(ScreenEdge::touched(1919.5, 10.0, area, none), ScreenEdge::Right.bit());
        let right_neighbour = |x: f64, _: f64| x >= 1920.0;
        assert_eq!(ScreenEdge::touched(1919.0, 0.0, area, right_neighbour), ScreenEdge::Top.bit());
    }

    #[test]
    fn changes_say_which_edges_were_entered_and_left() {
        let top_left = ScreenEdge::Top.bit() | ScreenEdge::Left.bit();
        let changed: Vec<_> = ScreenEdge::changes(top_left, ScreenEdge::Top.bit() | ScreenEdge::Right.bit()).collect();
        assert_eq!(changed, [(ScreenEdge::Right, true), (ScreenEdge::Left, false)]);
        assert_eq!(ScreenEdge::changes(top_left, top_left).count(), 0);
    }
}
