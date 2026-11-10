//! The system's proxies (System Settings > Network > Proxies), per request through CFNetwork: `CFNetworkCopyProxiesForURL`
//! applies the exceptions list and "Exclude simple hostnames"; an automatic configuration (PAC URL or script, WPAD) is run with
//! `CFNetworkExecuteProxyAutoConfiguration*` on this thread's run loop. Runs on the `acde-proxy` thread.

use super::{Endpoint, Hop};
use std::ffi::{c_char, c_void};
use std::ptr::null;
use std::time::{Duration, Instant};
use url::Url;

/// how long a PAC script may take to download and answer
const SCRIPT: Duration = Duration::from_secs(10);
const UTF8: u32 = 0x0800_0100;
const SINT32: isize = 3;

type Ref = *const c_void;
type Answered = extern "C" fn(*mut c_void, Ref, Ref);

#[repr(C)]
struct StreamClientContext {
    version: isize,
    info: *mut c_void,
    retain: Ref,
    release: Ref,
    copy_description: Ref,
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    static kCFRunLoopDefaultMode: Ref;
    fn CFRelease(cf: Ref);
    fn CFRetain(cf: Ref) -> Ref;
    fn CFEqual(a: Ref, b: Ref) -> u8;
    fn CFURLCreateWithBytes(allocator: Ref, bytes: *const u8, length: isize, encoding: u32, base: Ref) -> Ref;
    fn CFArrayGetCount(array: Ref) -> isize;
    fn CFArrayGetValueAtIndex(array: Ref, index: isize) -> Ref;
    fn CFDictionaryGetValue(dictionary: Ref, key: Ref) -> Ref;
    fn CFStringGetCString(string: Ref, buffer: *mut c_char, size: isize, encoding: u32) -> u8;
    fn CFNumberGetValue(number: Ref, kind: isize, value: *mut c_void) -> u8;
    fn CFRunLoopGetCurrent() -> Ref;
    fn CFRunLoopAddSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRemoveSource(run_loop: Ref, source: Ref, mode: Ref);
    fn CFRunLoopRunInMode(mode: Ref, seconds: f64, return_after_source_handled: u8) -> i32;
    fn CFRunLoopStop(run_loop: Ref);
    fn CFRunLoopSourceInvalidate(source: Ref);
}

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    static kCFProxyTypeKey: Ref;
    static kCFProxyHostNameKey: Ref;
    static kCFProxyPortNumberKey: Ref;
    static kCFProxyAutoConfigurationURLKey: Ref;
    static kCFProxyAutoConfigurationJavaScriptKey: Ref;
    static kCFProxyTypeNone: Ref;
    static kCFProxyTypeHTTP: Ref;
    static kCFProxyTypeHTTPS: Ref;
    static kCFProxyTypeSOCKS: Ref;
    static kCFProxyTypeAutoConfigurationURL: Ref;
    static kCFProxyTypeAutoConfigurationJavaScript: Ref;
    fn CFNetworkCopySystemProxySettings() -> Ref;
    fn CFNetworkCopyProxiesForURL(url: Ref, settings: Ref) -> Ref;
    fn CFNetworkExecuteProxyAutoConfigurationURL(script: Ref, url: Ref, answered: Answered, context: *mut StreamClientContext) -> Ref;
    fn CFNetworkExecuteProxyAutoConfigurationScript(script: Ref, url: Ref, answered: Answered, context: *mut StreamClientContext) -> Ref;
}

pub(super) fn find(url: &Url) -> Vec<Hop> {
    let hops = unsafe {
        let settings = CFNetworkCopySystemProxySettings();
        if settings.is_null() {
            return vec![Hop::Direct];
        }
        let text = url.as_str();
        let target = CFURLCreateWithBytes(null(), text.as_ptr(), text.len() as isize, UTF8, null());
        let mut hops = Vec::new();
        if !target.is_null() {
            let list = CFNetworkCopyProxiesForURL(target, settings);
            if !list.is_null() {
                hops = convert(list, target, true);
                CFRelease(list);
            }
            CFRelease(target);
        }
        CFRelease(settings);
        hops
    };
    if hops.is_empty() { vec![Hop::Direct] } else { hops }
}

/// an array of proxy dictionaries; a PAC entry is run (not again inside its own answer)
unsafe fn convert(list: Ref, target: Ref, scripts: bool) -> Vec<Hop> {
    let mut hops = Vec::new();
    for i in 0..unsafe { CFArrayGetCount(list) } {
        let proxy = unsafe { CFArrayGetValueAtIndex(list, i) };
        let kind = unsafe { CFDictionaryGetValue(proxy, kCFProxyTypeKey) };
        let is = |other: Ref| !kind.is_null() && unsafe { CFEqual(kind, other) } != 0;
        if is(unsafe { kCFProxyTypeNone }) {
            hops.push(Hop::Direct);
        } else if is(unsafe { kCFProxyTypeHTTP }) || is(unsafe { kCFProxyTypeHTTPS }) {
            hops.extend(unsafe { endpoint(proxy) }.map(Hop::Http));
        } else if is(unsafe { kCFProxyTypeSOCKS }) {
            hops.extend(unsafe { endpoint(proxy) }.map(Hop::Socks5));
        } else if scripts && is(unsafe { kCFProxyTypeAutoConfigurationURL }) {
            let script = unsafe { CFDictionaryGetValue(proxy, kCFProxyAutoConfigurationURLKey) };
            hops.extend(unsafe { run(script, target, CFNetworkExecuteProxyAutoConfigurationURL) });
        } else if scripts && is(unsafe { kCFProxyTypeAutoConfigurationJavaScript }) {
            let script = unsafe { CFDictionaryGetValue(proxy, kCFProxyAutoConfigurationJavaScriptKey) };
            hops.extend(unsafe { run(script, target, CFNetworkExecuteProxyAutoConfigurationScript) });
        }
    }
    hops
}

unsafe fn endpoint(proxy: Ref) -> Option<Endpoint> {
    let host = unsafe { CFDictionaryGetValue(proxy, kCFProxyHostNameKey) };
    let port = unsafe { CFDictionaryGetValue(proxy, kCFProxyPortNumberKey) };
    if host.is_null() || port.is_null() {
        return None;
    }
    let mut buffer = [0 as c_char; 1024];
    if unsafe { CFStringGetCString(host, buffer.as_mut_ptr(), buffer.len() as isize, UTF8) } == 0 {
        return None;
    }
    let host = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr()) }.to_str().ok()?.to_owned();
    let mut number: i32 = 0;
    if unsafe { CFNumberGetValue(port, SINT32, (&raw mut number).cast()) } == 0 {
        return None;
    }
    let port = u16::try_from(number).ok().filter(|port| *port != 0)?;
    Some(Endpoint { host: host.trim_start_matches('[').trim_end_matches(']').to_owned(), port })
}

struct Answer {
    done: bool,
    list: Ref,
}

extern "C" fn answered(info: *mut c_void, list: Ref, error: Ref) {
    let answer = info.cast::<Answer>();
    unsafe {
        (*answer).done = true;
        if error.is_null() && !list.is_null() {
            (*answer).list = CFRetain(list);
        }
        CFRunLoopStop(CFRunLoopGetCurrent());
    }
}

/// Runs a PAC script for `target` on this thread's run loop, at most `SCRIPT` long; its answer, or nothing.
unsafe fn run(script: Ref, target: Ref, execute: unsafe extern "C" fn(Ref, Ref, Answered, *mut StreamClientContext) -> Ref) -> Vec<Hop> {
    if script.is_null() {
        return Vec::new();
    }
    let answer = Box::into_raw(Box::new(Answer { done: false, list: null() }));
    let mut context = StreamClientContext { version: 0, info: answer.cast(), retain: null(), release: null(), copy_description: null() };
    let source = unsafe { execute(script, target, answered, &mut context) };
    let mut hops = Vec::new();
    if !source.is_null() {
        let (run_loop, mode) = unsafe { (CFRunLoopGetCurrent(), kCFRunLoopDefaultMode) };
        unsafe { CFRunLoopAddSource(run_loop, source, mode) };
        let until = Instant::now() + SCRIPT;
        while !unsafe { (*answer).done } {
            let left = until.saturating_duration_since(Instant::now());
            if left.is_zero() {
                log::warn!("proxy: the automatic proxy configuration did not answer in {} seconds", SCRIPT.as_secs());
                break;
            }
            unsafe { CFRunLoopRunInMode(mode, left.as_secs_f64(), 0) };
        }
        unsafe {
            CFRunLoopSourceInvalidate(source);
            CFRunLoopRemoveSource(run_loop, source, mode);
            CFRelease(source);
        }
    }
    let list = unsafe { (*answer).list };
    if !list.is_null() {
        hops = unsafe { convert(list, target, false) };
        unsafe { CFRelease(list) };
    }
    drop(unsafe { Box::from_raw(answer) });
    hops
}
