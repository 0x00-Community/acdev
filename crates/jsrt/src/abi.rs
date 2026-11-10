pub const MAGIC: u8 = 0xAC;
pub const AREA_MAGIC: u32 = 0x7472736a;
pub const EVAL_MODULE: u32 = 1;
pub const CMD_WAIT: u32 = io(0x62);
pub const CMD_KICK: u32 = io(0x63);

const fn io(nr: u32) -> u32 {
    ((MAGIC as u32) << 8) | nr
}

#[repr(C)]
pub struct Create {
    pub size: u32,
    pub flags: u32,
    pub name: u64,
    pub mem_limit: u64,
    pub stack_size: u32,
    pub ring_size: u32,
}

#[repr(C)]
pub struct Eval {
    pub size: u32,
    pub flags: u32,
    pub source: u64,
    pub source_len: u64,
    pub name: u64,
}

#[repr(C)]
pub struct RingHeader {
    pub head: u32,
    pub tail: u32,
    pub offset: u32,
    pub size: u32,
}

#[repr(C)]
pub struct Area {
    pub magic: u32,
    pub size: u32,
    pub to_window: RingHeader,
    pub to_engine: RingHeader,
    pub exit_code: i32,
    pub reserved: u32,
    pub replies: RingHeader,
}

/// JSRT_MSG_PART: the start of a message longer than one record.
pub const PART: u16 = 7;

#[repr(C)]
pub struct MsgHeader {
    pub len: u32,
    pub kind: u16,
    pub flags: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    String,
    Binary,
    Console,
    Error,
    Call,
    Reply,
    Other(u16),
}

impl From<u16> for Kind {
    fn from(n: u16) -> Self {
        match n {
            1 => Kind::String,
            2 => Kind::Binary,
            3 => Kind::Console,
            4 => Kind::Error,
            5 => Kind::Call,
            6 => Kind::Reply,
            n => Kind::Other(n),
        }
    }
}

impl From<Kind> for u16 {
    fn from(k: Kind) -> u16 {
        match k {
            Kind::String => 1,
            Kind::Binary => 2,
            Kind::Console => 3,
            Kind::Error => 4,
            Kind::Call => 5,
            Kind::Reply => 6,
            Kind::Other(n) => n,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Events(u32);

impl Events {
    pub const MESSAGES: Events = Events(1);
    pub const SPACE: Events = Events(2);
    pub const EXIT: Events = Events(4);

    pub const fn empty() -> Self {
        Events(0)
    }

    pub const fn from_bits(bits: u32) -> Self {
        Events(bits)
    }

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn contains(self, other: Events) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn is_empty(self) -> bool {
        self.0 == 0
    }
}

impl std::ops::BitOr for Events {
    type Output = Events;

    fn bitor(self, other: Events) -> Events {
        Events(self.0 | other.0)
    }
}

const _: () = assert!(size_of::<Create>() == 32);
const _: () = assert!(size_of::<Eval>() == 32);
const _: () = assert!(size_of::<Area>() == 64);
const _: () = assert!(size_of::<MsgHeader>() == 8);
