use std::sync::atomic::{AtomicU32, Ordering};

use crate::Full;
use crate::abi::{MsgHeader, RingHeader};

const HEADER: usize = size_of::<MsgHeader>();

pub struct Ring {
    head: *const AtomicU32,
    tail: *const AtomicU32,
    data: *mut u8,
    size: u32,
}

impl Ring {
    pub fn new(header: &RingHeader, data: *mut u8, size: u32) -> Self {
        Ring {
            head: (&raw const header.head).cast(),
            tail: (&raw const header.tail).cast(),
            data,
            size,
        }
    }

    fn head(&self) -> &AtomicU32 {
        unsafe { &*self.head }
    }

    fn tail(&self) -> &AtomicU32 {
        unsafe { &*self.tail }
    }

    fn copy_in(&self, pos: u32, src: &[u8]) {
        let off = (pos & (self.size - 1)) as usize;
        let first = src.len().min(self.size as usize - off);
        unsafe {
            std::ptr::copy_nonoverlapping(src.as_ptr(), self.data.add(off), first);
            std::ptr::copy_nonoverlapping(src.as_ptr().add(first), self.data, src.len() - first);
        }
    }

    fn copy_out(&self, pos: u32, dst: &mut [u8]) {
        let off = (pos & (self.size - 1)) as usize;
        let first = dst.len().min(self.size as usize - off);
        unsafe {
            std::ptr::copy_nonoverlapping(self.data.add(off), dst.as_mut_ptr(), first);
            std::ptr::copy_nonoverlapping(self.data, dst.as_mut_ptr().add(first), dst.len() - first);
        }
    }

    pub fn put(&self, kind: u16, flags: u16, parts: &[&[u8]]) -> Result<(), Full> {
        let len: usize = parts.iter().map(|p| p.len()).sum();
        let need = (HEADER + len).next_multiple_of(8);
        let tail = self.tail().load(Ordering::Relaxed);
        let head = self.head().load(Ordering::Acquire);
        if need > (self.size - tail.wrapping_sub(head)) as usize {
            return Err(Full);
        }
        let header = MsgHeader {
            len: len as u32,
            kind,
            flags,
        };
        let bytes = unsafe { std::slice::from_raw_parts((&raw const header).cast::<u8>(), HEADER) };
        self.copy_in(tail, bytes);
        let mut pos = tail.wrapping_add(HEADER as u32);
        for part in parts {
            self.copy_in(pos, part);
            pos = pos.wrapping_add(part.len() as u32);
        }
        self.tail().store(tail.wrapping_add(need as u32), Ordering::Release);
        Ok(())
    }

    pub fn take(&self, buf: &mut Vec<u8>) -> Option<(u16, u16)> {
        let head = self.head().load(Ordering::Relaxed);
        let tail = self.tail().load(Ordering::Acquire);
        if head == tail {
            return None;
        }
        let mut bytes = [0u8; HEADER];
        self.copy_out(head, &mut bytes);
        let header: MsgHeader = unsafe { std::ptr::read_unaligned(bytes.as_ptr().cast()) };
        buf.clear();
        buf.resize(header.len as usize, 0);
        self.copy_out(head.wrapping_add(HEADER as u32), buf);
        let need = (HEADER + header.len as usize).next_multiple_of(8);
        self.head().store(head.wrapping_add(need as u32), Ordering::Release);
        Some((header.kind, header.flags))
    }
}
