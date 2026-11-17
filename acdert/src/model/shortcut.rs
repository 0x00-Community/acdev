wire!("scope" Scope { Session = "session", Desktop = "desktop", App = "app", Menu = "menu" });

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

    pub fn mods(ctrl: bool, alt: bool, shift: bool, logo: bool) -> u8 {
        [(ctrl, Self::CTRL), (alt, Self::ALT), (shift, Self::SHIFT), (logo, Self::SUPER)].into_iter().filter(|(on, _)| *on).fold(0, |a, (_, bit)| a | bit)
    }

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
                "mod" if cfg!(target_os = "macos") => Self::SUPER,
                "mod" => Self::CTRL,
                other => return Err(format!("shortcut {text}: unknown modifier {other}")),
            };
        }
        combo.key = key(last).ok_or_else(|| format!("shortcut {text}: unknown key {last}"))?;
        Ok(combo)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
    names: std::collections::HashMap<Binding, String>,
}

impl Shortcuts {
    pub fn name(&self, binding: Binding) -> Option<&str> {
        self.names.get(&binding).map(String::as_str)
    }

    pub fn register(&mut self, new: Binding, name: &str) -> Result<(), Taken> {
        let clash = self.bindings.iter().find(|b| {
            b.combo == new.combo
                && match (b.scope, new.scope) {
                    (Scope::Session, _) | (_, Scope::Session) => true,
                    (Scope::App, Scope::App) | (Scope::Menu, Scope::Menu) => b.owner == new.owner,
                    (x, y) => x == y,
                }
        });
        match clash {
            Some(b) if *b != new => return Err(Taken(*b)),
            Some(_) => {}
            None => self.bindings.push(new),
        }
        self.names.insert(new, name.to_owned());
        Ok(())
    }

    pub fn unregister(&mut self, combo: Combo, scope: Scope, owner: u32) {
        self.bindings.retain(|b| !(b.combo == combo && b.scope == scope && b.owner == owner));
        self.names.retain(|b, _| !(b.combo == combo && b.scope == scope && b.owner == owner));
    }

    pub fn forget(&mut self, owner: u32) {
        let owned = |b: &Binding| matches!(b.scope, Scope::App | Scope::Menu) && b.owner == owner;
        self.bindings.retain(|b| !owned(b));
        self.names.retain(|b, _| !owned(b));
    }

    pub fn find(&self, combo: Combo, focused: Option<u32>) -> Option<Binding> {
        let windowed = |scope: Scope| matches!(scope, Scope::App | Scope::Menu);
        let of = |scope: Scope| self.bindings.iter().find(|b| b.combo == combo && b.scope == scope && (!windowed(scope) || Some(b.owner) == focused));
        of(Scope::Session).or_else(|| of(Scope::Menu)).or_else(|| of(Scope::App)).or_else(|| of(Scope::Desktop)).copied()
    }
}
