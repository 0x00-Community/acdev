//! An isolate's external memory: what it holds outside its V8 heap (ArrayBuffer backing stores, its render document's
//! images), counted against its own cap and reported to its V8 heap so the GC sees the pressure. Over the cap the
//! allocation fails (a RangeError in the page, as in a browser) and the isolate is ended with reason `memory`.

use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub struct Budget {
    cap: usize,
    used: AtomicUsize,
    over: AtomicBool,
}

impl Budget {
    const MB: usize = 1024 * 1024;

    pub fn new(cap_mb: usize) -> Arc<Self> {
        Arc::new(Self { cap: cap_mb.max(1) * Self::MB, used: AtomicUsize::new(0), over: AtomicBool::new(false) })
    }

    /// Takes `len` bytes if they fit under the cap; marks the budget as over when they do not.
    fn take(&self, len: usize) -> bool {
        let fits = self.used.try_update(Ordering::AcqRel, Ordering::Acquire, |used| used.checked_add(len).filter(|&n| n <= self.cap)).is_ok();
        if !fits {
            self.over.store(true, Ordering::Release);
        }
        fits
    }

    fn give(&self, len: usize) {
        self.used.fetch_sub(len, Ordering::AcqRel);
    }

    /// Moves a counted amount held outside the allocator (the render document's images) from `was` to `now` bytes.
    pub fn hold(&self, was: usize, now: usize) {
        if now > was {
            self.take(now - was);
        } else {
            self.give(was - now);
        }
    }

    pub fn used(&self) -> usize {
        self.used.load(Ordering::Acquire)
    }

    /// Whether something was refused or went over: the isolate is to end.
    pub fn over(&self) -> bool {
        self.over.load(Ordering::Acquire)
    }

    /// The ArrayBuffer allocator for this isolate's `CreateParams`: malloc / calloc, counted here.
    pub fn allocator(self: &Arc<Self>) -> v8::UniqueRef<v8::Allocator> {
        const VTABLE: v8::RustAllocatorVtable<Budget> = v8::RustAllocatorVtable { allocate, allocate_uninitialized, free, drop: release };
        // SAFETY: the handle is an `Arc<Budget>` given up to V8, which `release` takes back when the allocator goes.
        unsafe { v8::new_rust_allocator(Arc::into_raw(self.clone()), &VTABLE) }
    }
}

/// Backing stores are aligned like malloc's; a zero-length one still gets a byte, so the pointer is never dangling.
fn layout(len: usize) -> Option<std::alloc::Layout> {
    std::alloc::Layout::from_size_align(len.max(1), 16).ok()
}

fn counted(budget: &Budget, len: usize, get: unsafe fn(std::alloc::Layout) -> *mut u8) -> *mut c_void {
    let Some(layout) = layout(len) else { return std::ptr::null_mut() };
    if !budget.take(len) {
        return std::ptr::null_mut();
    }
    // SAFETY: the layout has a non-zero size; a null result is handed to V8 as a failed allocation.
    let data = unsafe { get(layout) };
    if data.is_null() {
        budget.give(len);
    }
    data.cast()
}

unsafe extern "C" fn allocate(budget: &Budget, len: usize) -> *mut c_void {
    counted(budget, len, std::alloc::alloc_zeroed)
}

unsafe extern "C" fn allocate_uninitialized(budget: &Budget, len: usize) -> *mut c_void {
    counted(budget, len, std::alloc::alloc)
}

unsafe extern "C" fn free(budget: &Budget, data: *mut c_void, len: usize) {
    if let Some(layout) = layout(len).filter(|_| !data.is_null()) {
        // SAFETY: `data` came from `counted` with this same length, so with this layout.
        unsafe { std::alloc::dealloc(data.cast(), layout) };
        budget.give(len);
    }
}

unsafe extern "C" fn release(budget: *const Budget) {
    // SAFETY: the `Arc::into_raw` of `Budget::allocator`.
    drop(unsafe { Arc::from_raw(budget) });
}
