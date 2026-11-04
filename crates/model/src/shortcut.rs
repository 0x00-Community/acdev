#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Scope {
    Session,
    Desktop,
    App,
}

impl std::str::FromStr for Scope {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        Ok(match s {
            "session" => Scope::Session,
            "desktop" => Scope::Desktop,
            "app" => Scope::App,
            other => return Err(format!("unknown scope {other}")),
        })
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Combo {
    pub mods: u8,
    pub key: u32,
}

impl Combo {
    pub const CTRL: u8 = 1;
    pub const ALT: u8 = 2;
    pub const SHIFT: u8 = 4;
    pub const SUPER: u8 = 8;

    pub fn parse(text: &str, key: impl Fn(&str) -> Option<u32>) -> Result<Self, String> {
        let mut combo = Combo::default();
        let mut parts: Vec<&str> = text.split('+').map(str::trim).collect();
        let last = parts.pop().filter(|k| !k.is_empty()).ok_or_else(|| format!("shortcut {text}: no key"))?;
        for m in parts {
            combo.mods |= match m.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => Self::CTRL,
                "alt" => Self::ALT,
                "shift" => Self::SHIFT,
                "super" | "meta" | "logo" => Self::SUPER,
                other => return Err(format!("shortcut {text}: unknown modifier {other}")),
            };
        }
        combo.key = key(last).ok_or_else(|| format!("shortcut {text}: unknown key {last}"))?;
        Ok(combo)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    pub combo: Combo,
    pub scope: Scope,
    pub owner: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Taken(pub Binding);

impl std::fmt::Display for Taken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "shortcut taken by {:?} owner {}", self.0.scope, self.0.owner)
    }
}

#[derive(Default)]
pub struct Shortcuts {
    bindings: Vec<Binding>,
}

impl Shortcuts {
    pub fn register(&mut self, new: Binding) -> Result<(), Taken> {
        let clash = self.bindings.iter().find(|b| {
            b.combo == new.combo
                && match (b.scope, new.scope) {
                    (Scope::Session, _) | (_, Scope::Session) => true,
                    (Scope::App, Scope::App) => b.owner == new.owner,
                    (x, y) => x == y,
                }
        });
        match clash {
            Some(b) if *b == new => Ok(()),
            Some(b) => Err(Taken(*b)),
            None => {
                self.bindings.push(new);
                Ok(())
            }
        }
    }

    pub fn unregister(&mut self, combo: Combo, scope: Scope, owner: u32) {
        self.bindings.retain(|b| !(b.combo == combo && b.scope == scope && b.owner == owner));
    }

    pub fn forget(&mut self, owner: u32) {
        self.bindings.retain(|b| !(b.scope == Scope::App && b.owner == owner));
    }

    pub fn find(&self, combo: Combo, focused: Option<u32>) -> Option<Binding> {
        let of = |scope: Scope| self.bindings.iter().find(|b| b.combo == combo && b.scope == scope && (scope != Scope::App || Some(b.owner) == focused));
        of(Scope::Session).or_else(|| of(Scope::App)).or_else(|| of(Scope::Desktop)).copied()
    }
}
