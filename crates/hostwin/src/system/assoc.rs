//! What Windows knows about file types through its file associations: the content type it registers for an extension
//! (`HKEY_CLASSES_ROOT\.<ext>` `Content Type`, read with `AssocQueryStringW(ASSOCSTR_CONTENTTYPE)`), and the programs
//! registered to open it, as the shell's "Open with" lists them (`SHAssocEnumHandlers`). The system default is only read.

use std::ffi::c_void;
use std::marker::PhantomData;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::S_OK;
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC, DeleteObject, GdiFlush, SelectObject,
};
use windows_sys::Win32::System::Com::{COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoInitializeEx, CoTaskMemFree, CoUninitialize};
use windows_sys::Win32::UI::Shell::{
    ASSOC_FILTER, ASSOC_FILTER_NONE, ASSOC_FILTER_RECOMMENDED, ASSOCF_INIT_IGNOREUNKNOWN, ASSOCSTR, ASSOCSTR_APPID, ASSOCSTR_CONTENTTYPE, ASSOCSTR_EXECUTABLE,
    AssocQueryStringW, BHID_DataObject, SHAssocEnumHandlers, SHCreateItemFromParsingName, SHDefExtractIconW, SHLoadIndirectString,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{DI_NORMAL, DestroyIcon, DrawIconEx, HICON};
use windows_sys::core::{GUID, HRESULT, PCWSTR, PWSTR};

use super::handoff::{OpenError, Target};

const EXTENSION_MAX: usize = 64;
const ICON_SIZE: u32 = 32;
const IID_ISHELLITEM: GUID = GUID::from_u128(0x43826d1e_e718_42ee_bc55_a1e261c37bfe);
const IID_IDATAOBJECT: GUID = GUID::from_u128(0x0000010e_0000_0000_c000_000000000046);

/// A program Windows lists for opening a file type.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Handler {
    /// What the shell calls it (`IAssocHandler::GetName`): the program's full path, or a packaged app's id.
    pub name: String,
    /// The name people see ("Photos", "Notepad").
    pub label: String,
    /// The program's icon as a `data:image/png` URL, empty when there is none.
    pub icon: String,
    /// Whether it is the system's default program for the extension.
    pub default: bool,
}

/// `.ext` as a NUL-terminated wide string, or `None` for anything that is not one plain extension.
pub(crate) fn wide_extension(extension: &str) -> Option<Vec<u16>> {
    let name = extension.strip_prefix('.')?;
    let plain = |c: char| !c.is_whitespace() && !c.is_control() && !matches!(c, '.' | '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|');
    if name.is_empty() || extension.len() > EXTENSION_MAX || !name.chars().all(plain) {
        return None;
    }
    Some(extension.encode_utf16().chain([0]).collect())
}

/// One association string for an extension; `None` when Windows has none (an unknown extension is not answered
/// with the "Open with" dialog, thanks to `ASSOCF_INIT_IGNOREUNKNOWN`).
pub(crate) fn query(what: ASSOCSTR, extension: &[u16]) -> Option<String> {
    let mut len = 0u32;
    let sized = unsafe { AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, extension.as_ptr(), null(), null_mut(), &mut len) };
    if sized < 0 || len == 0 {
        return None;
    }
    let mut buffer = vec![0u16; len as usize];
    let done = unsafe { AssocQueryStringW(ASSOCF_INIT_IGNOREUNKNOWN, what, extension.as_ptr(), null(), buffer.as_mut_ptr(), &mut len) };
    if done != S_OK {
        return None;
    }
    let text = String::from_utf16(until_nul(&buffer)).ok()?;
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn until_nul(wide: &[u16]) -> &[u16] {
    &wide[..wide.iter().position(|&c| c == 0).unwrap_or(wide.len())]
}

/// The content type Windows registers for `.ext`, as it reports it (`.csv` may well be `application/vnd.ms-excel`).
pub fn content_type(extension: &str) -> Option<String> {
    query(ASSOCSTR_CONTENTTYPE, &wide_extension(extension)?)
}

/// The programs Windows recommends for `.ext` (the shell's "Open with" list), the system default marked.
pub fn handlers(extension: &str) -> Result<Vec<Handler>, String> {
    let wide = wide_extension(extension).ok_or_else(|| format!("not a file extension: {extension:?}"))?;
    let _com = Com::init();
    let defaults: Vec<String> = [ASSOCSTR_EXECUTABLE, ASSOCSTR_APPID].into_iter().filter_map(|what| query(what, &wide)).collect();
    let mut out: Vec<Handler> = Vec::new();
    for handler in AssocHandler::all(&wide, ASSOC_FILTER_RECOMMENDED)? {
        let Some(name) = handler.name() else { continue };
        if out.iter().any(|h| h.name.eq_ignore_ascii_case(&name)) {
            continue;
        }
        let label = handler.label().unwrap_or_else(|| name.clone());
        let icon = handler.icon().and_then(|(location, index)| icon_url(&location, index)).unwrap_or_default();
        let default = defaults.iter().any(|d| d.eq_ignore_ascii_case(&name));
        out.push(Handler { name, label, icon, default });
    }
    Ok(out)
}

/// Opens `path` in the program `name` registered for its extension (`IAssocHandler::Invoke`), the way "Open with"
/// does. The path gets the same checks as a hand-off to the system default, but no list of extensions: the user
/// picked this program for this file. The system's own default is left as it is.
pub fn open_with(name: &str, path: &str, headless: bool) -> Result<(), OpenError> {
    let file = Target::chosen(Path::new(path))?;
    let extension = file.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let refused = |why: String| OpenError::Refused(format!("{} is not opened with {name}: {why}", file.display()));
    let wide = wide_extension(&extension).ok_or_else(|| refused("it has no file extension".into()))?;
    let _com = Com::init();
    let handler = AssocHandler::all(&wide, ASSOC_FILTER_NONE)
        .map_err(OpenError::Failed)?
        .into_iter()
        .find(|h| h.name().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .ok_or_else(|| refused(format!("not a program Windows registers for {extension} files")))?;
    if headless {
        log::info!("open with {name} (ACDE_HEADLESS, not opened): {}", file.display());
        return Ok(());
    }
    log::info!("open with {name}: {}", file.display());
    let data = data_object(&file).map_err(OpenError::Failed)?;
    let invoked = unsafe { (handler.vtable().invoke)(handler.raw(), data.raw()) };
    if invoked < 0 { Err(OpenError::Failed(format!("{name} {}: error {invoked:#x}", file.display()))) } else { Ok(()) }
}

/// COM on this thread for as long as it lives (the association objects are apartment threaded).
struct Com(bool);

impl Com {
    fn init() -> Com {
        let hr = unsafe { CoInitializeEx(null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
        Com(hr >= 0)
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

#[repr(C)]
#[allow(dead_code)]
struct UnknownVtbl {
    query_interface: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
    add_ref: unsafe extern "system" fn(*mut c_void) -> u32,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
}

#[repr(C)]
#[allow(dead_code)]
struct EnumAssocHandlersVtbl {
    base: UnknownVtbl,
    next: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void, *mut u32) -> HRESULT,
}

#[repr(C)]
#[allow(dead_code)]
struct AssocHandlerVtbl {
    base: UnknownVtbl,
    get_name: unsafe extern "system" fn(*mut c_void, *mut PWSTR) -> HRESULT,
    get_ui_name: unsafe extern "system" fn(*mut c_void, *mut PWSTR) -> HRESULT,
    get_icon_location: unsafe extern "system" fn(*mut c_void, *mut PWSTR, *mut i32) -> HRESULT,
    is_recommended: unsafe extern "system" fn(*mut c_void) -> HRESULT,
    make_default: unsafe extern "system" fn(*mut c_void, PCWSTR) -> HRESULT,
    invoke: unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
    create_invoker: unsafe extern "system" fn(*mut c_void, *mut c_void, *mut *mut c_void) -> HRESULT,
}

#[repr(C)]
#[allow(dead_code)]
struct ShellItemVtbl {
    base: UnknownVtbl,
    bind_to_handler: unsafe extern "system" fn(*mut c_void, *mut c_void, *const GUID, *const GUID, *mut *mut c_void) -> HRESULT,
}

/// An owned COM interface pointer whose vtable starts like `V`; released on drop.
struct Interface<V>(*mut c_void, PhantomData<V>);

impl<V> Interface<V> {
    fn new(raw: *mut c_void) -> Option<Self> {
        (!raw.is_null()).then_some(Interface(raw, PhantomData))
    }

    fn raw(&self) -> *mut c_void {
        self.0
    }

    fn vtable(&self) -> &V {
        unsafe { &**(self.0 as *const *const V) }
    }
}

impl<V> Drop for Interface<V> {
    fn drop(&mut self) {
        unsafe {
            let base = &**(self.0 as *const *const UnknownVtbl);
            (base.release)(self.0);
        }
    }
}

type AssocHandler = Interface<AssocHandlerVtbl>;

impl AssocHandler {
    fn all(extension: &[u16], filter: ASSOC_FILTER) -> Result<Vec<AssocHandler>, String> {
        let mut raw = null_mut();
        let hr = unsafe { SHAssocEnumHandlers(extension.as_ptr(), filter, &mut raw) };
        let list = Interface::<EnumAssocHandlersVtbl>::new(raw).filter(|_| hr >= 0).ok_or_else(|| format!("SHAssocEnumHandlers: error {hr:#x}"))?;
        let mut out = Vec::new();
        loop {
            let (mut item, mut fetched) = (null_mut(), 0u32);
            let hr = unsafe { (list.vtable().next)(list.raw(), 1, &mut item, &mut fetched) };
            let item = Interface::new(item);
            if hr != S_OK || fetched == 0 {
                break;
            }
            out.extend(item);
        }
        Ok(out)
    }

    fn name(&self) -> Option<String> {
        let mut text = null_mut();
        let hr = unsafe { (self.vtable().get_name)(self.raw(), &mut text) };
        unsafe { taken(hr, text) }
    }

    fn label(&self) -> Option<String> {
        let mut text = null_mut();
        let hr = unsafe { (self.vtable().get_ui_name)(self.raw(), &mut text) };
        unsafe { taken(hr, text) }
    }

    fn icon(&self) -> Option<(String, i32)> {
        let (mut text, mut index) = (null_mut(), 0i32);
        let hr = unsafe { (self.vtable().get_icon_location)(self.raw(), &mut text, &mut index) };
        unsafe { taken(hr, text) }.map(|location| (location, index))
    }
}

/// A string the callee allocated with `CoTaskMemAlloc`: copied and freed.
unsafe fn taken(hr: HRESULT, text: PWSTR) -> Option<String> {
    if text.is_null() {
        return None;
    }
    let len = (0..).take_while(|&i| unsafe { *text.add(i) } != 0).count();
    let copy = String::from_utf16_lossy(unsafe { std::slice::from_raw_parts(text, len) });
    unsafe { CoTaskMemFree(text as *const c_void) };
    (hr >= 0 && !copy.trim().is_empty()).then_some(copy)
}

fn wide_path(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain([0]).collect()
}

/// The file as the data object a handler is invoked with (`IShellItem::BindToHandler(BHID_DataObject)`).
fn data_object(path: &Path) -> Result<Interface<UnknownVtbl>, String> {
    let wide = wide_path(path);
    let mut raw = null_mut();
    let hr = unsafe { SHCreateItemFromParsingName(wide.as_ptr(), null_mut(), &IID_ISHELLITEM, &mut raw) };
    let item = Interface::<ShellItemVtbl>::new(raw).filter(|_| hr >= 0).ok_or_else(|| format!("{}: error {hr:#x}", path.display()))?;
    let mut data = null_mut();
    let hr = unsafe { (item.vtable().bind_to_handler)(item.raw(), null_mut(), &BHID_DataObject, &IID_IDATAOBJECT, &mut data) };
    Interface::new(data).filter(|_| hr >= 0).ok_or_else(|| format!("{}: no data object, error {hr:#x}", path.display()))
}

/// A handler's icon as a PNG data URL: a packaged app's logo file (`@{…}` resource), or the icon in an executable.
fn icon_url(location: &str, index: i32) -> Option<String> {
    let png = if location.starts_with("@{") { packaged_logo(location)? } else { extracted_icon(location, index)? };
    Some(format!("data:image/png;base64,{}", base64(&png)))
}

fn packaged_logo(location: &str) -> Option<Vec<u8>> {
    let source: Vec<u16> = location.encode_utf16().chain([0]).collect();
    let mut path = vec![0u16; 1024];
    let hr = unsafe { SHLoadIndirectString(source.as_ptr(), path.as_mut_ptr(), path.len() as u32, null()) };
    if hr != S_OK {
        return None;
    }
    let path = String::from_utf16(until_nul(&path)).ok()?;
    let bytes = std::fs::read(path).ok()?;
    bytes.starts_with(b"\x89PNG\r\n\x1a\n").then_some(bytes)
}

fn extracted_icon(location: &str, index: i32) -> Option<Vec<u8>> {
    let file: Vec<u16> = location.encode_utf16().chain([0]).collect();
    let mut icon: HICON = null_mut();
    let hr = unsafe { SHDefExtractIconW(file.as_ptr(), index, 0, &mut icon, null_mut(), ICON_SIZE) };
    if hr != S_OK || icon.is_null() {
        return None;
    }
    let bgra = unsafe { draw(icon, ICON_SIZE as i32) };
    unsafe { DestroyIcon(icon) };
    acde_render::encode_png(ICON_SIZE, ICON_SIZE, &straight_rgba(&bgra?))
}

/// The icon drawn into a top-down 32-bit DIB: premultiplied BGRA rows.
unsafe fn draw(icon: HICON, size: i32) -> Option<Vec<u8>> {
    let dc = unsafe { CreateCompatibleDC(null_mut()) };
    if dc.is_null() {
        return None;
    }
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: size,
            biHeight: -size,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut bits = null_mut();
    let bitmap = unsafe { CreateDIBSection(dc, &info, DIB_RGB_COLORS, &mut bits, null_mut(), 0) };
    let mut out = None;
    if !bitmap.is_null() && !bits.is_null() {
        let old = unsafe { SelectObject(dc, bitmap) };
        if unsafe { DrawIconEx(dc, 0, 0, icon, size, size, 0, null_mut(), DI_NORMAL) } != 0 {
            unsafe { GdiFlush() };
            let len = (size * size * 4) as usize;
            out = Some(unsafe { std::slice::from_raw_parts(bits as *const u8, len) }.to_vec());
        }
        unsafe { SelectObject(dc, old) };
    }
    if !bitmap.is_null() {
        unsafe { DeleteObject(bitmap) };
    }
    unsafe { DeleteDC(dc) };
    out
}

/// Premultiplied BGRA to straight RGBA. Icons without an alpha channel come out with alpha 0 everywhere; their
/// drawn pixels are opaque and the untouched (black) background transparent.
fn straight_rgba(bgra: &[u8]) -> Vec<u8> {
    let has_alpha = bgra.chunks_exact(4).any(|p| p[3] != 0);
    let mut out = Vec::with_capacity(bgra.len());
    for p in bgra.chunks_exact(4) {
        let (b, g, r) = (p[0], p[1], p[2]);
        let a = if has_alpha {
            p[3]
        } else if (b, g, r) == (0, 0, 0) {
            0
        } else {
            255
        };
        let un = |c: u8| {
            if a == 0 {
                0
            } else if has_alpha {
                ((u32::from(c) * 255 + u32::from(a) / 2) / u32::from(a)).min(255) as u8
            } else {
                c
            }
        };
        out.extend_from_slice(&[un(r), un(g), un(b), a]);
    }
    out
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            out.push(if i <= chunk.len() { char::from(ALPHABET[(n >> (18 - 6 * i) & 63) as usize]) } else { '=' });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_extensions_are_asked() {
        for ok in [".png", ".TXT", ".tar", ".docx", ".7z"] {
            assert!(wide_extension(ok).is_some(), "{ok}");
        }
        for bad in ["png", ".", "", ".tar.gz", ".a b", r".a\b", ".a/b", ".a:b", ".a*", &format!(".{}", "x".repeat(EXTENSION_MAX))] {
            assert!(wide_extension(bad).is_none(), "{bad:?}");
        }
    }

    #[test]
    fn base64_pads_like_rfc_4648() {
        for (input, encoded) in [("", ""), ("f", "Zg=="), ("fo", "Zm8="), ("foo", "Zm9v"), ("foob", "Zm9vYg=="), ("fooba", "Zm9vYmE="), ("foobar", "Zm9vYmFy")]
        {
            assert_eq!(base64(input.as_bytes()), encoded, "{input:?}");
        }
    }

    #[test]
    fn icon_pixels_become_straight_rgba() {
        assert_eq!(straight_rgba(&[0, 0, 128, 128, 0, 0, 0, 0]), [255, 0, 0, 128, 0, 0, 0, 0]);
        assert_eq!(straight_rgba(&[10, 20, 30, 0, 0, 0, 0, 0]), [30, 20, 10, 255, 0, 0, 0, 0]);
    }
}
