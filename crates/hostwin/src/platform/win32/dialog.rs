use std::ffi::{OsString, c_void};
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr::{null, null_mut};

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::Com::{CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx, CoTaskMemFree};
use windows_sys::Win32::UI::Shell::Common::COMDLG_FILTERSPEC;
use windows_sys::Win32::UI::Shell::{FOS_ALLOWMULTISELECT, FOS_FILEMUSTEXIST, FOS_FORCEFILESYSTEM, FOS_OVERWRITEPROMPT, FOS_PICKFOLDERS, SIGDN_FILESYSPATH};
use windows_sys::core::{GUID, HRESULT, PCWSTR, PWSTR};

use crate::{FileFilter, OpenRequest, SaveRequest};

const CLSID_FILE_OPEN_DIALOG: GUID = GUID::from_u128(0xdc1c5a9c_e88a_4dde_a5a1_60f82a20aef7);
const CLSID_FILE_SAVE_DIALOG: GUID = GUID::from_u128(0xc0b4e2f3_ba21_4773_8dba_335ec946eb8b);
const IID_IFILE_OPEN_DIALOG: GUID = GUID::from_u128(0xd57c7288_d4ad_4768_be02_9d969532d960);
const IID_IFILE_SAVE_DIALOG: GUID = GUID::from_u128(0x84bccd23_5fde_4cdb_aea4_af64b83d78ab);

const CANCELLED: HRESULT = 0x800704C7u32 as i32;

type Object = *mut c_void;

#[repr(C)]
struct Unknown {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(Object) -> u32,
}

#[repr(C)]
struct FileDialog {
    base: Unknown,
    show: unsafe extern "system" fn(Object, HWND) -> HRESULT,
    set_file_types: unsafe extern "system" fn(Object, u32, *const COMDLG_FILTERSPEC) -> HRESULT,
    set_file_type_index: unsafe extern "system" fn(Object, u32) -> HRESULT,
    get_file_type_index: usize,
    advise: usize,
    unadvise: usize,
    set_options: unsafe extern "system" fn(Object, u32) -> HRESULT,
    get_options: unsafe extern "system" fn(Object, *mut u32) -> HRESULT,
    set_default_folder: usize,
    set_folder: usize,
    get_folder: usize,
    get_current_selection: usize,
    set_file_name: unsafe extern "system" fn(Object, PCWSTR) -> HRESULT,
    get_file_name: unsafe extern "system" fn(Object, *mut PWSTR) -> HRESULT,
    set_title: unsafe extern "system" fn(Object, PCWSTR) -> HRESULT,
    set_ok_button_label: usize,
    set_file_name_label: usize,
    get_result: unsafe extern "system" fn(Object, *mut Object) -> HRESULT,
    add_place: usize,
    set_default_extension: usize,
    close: usize,
    set_client_guid: usize,
    clear_client_data: usize,
    set_filter: usize,
}

#[repr(C)]
struct OpenDialog {
    base: FileDialog,
    get_results: unsafe extern "system" fn(Object, *mut Object) -> HRESULT,
    get_selected_items: usize,
}

#[repr(C)]
struct ShellItem {
    base: Unknown,
    bind_to_handler: usize,
    get_parent: usize,
    get_display_name: unsafe extern "system" fn(Object, i32, *mut PWSTR) -> HRESULT,
    get_attributes: usize,
    compare: usize,
}

#[repr(C)]
struct ShellItemArray {
    base: Unknown,
    bind_to_handler: usize,
    get_property_store: usize,
    get_property_description_list: usize,
    get_attributes: usize,
    get_count: unsafe extern "system" fn(Object, *mut u32) -> HRESULT,
    get_item_at: unsafe extern "system" fn(Object, u32, *mut Object) -> HRESULT,
    enum_items: usize,
}

struct Com(Object);

impl Com {
    fn vtable<V>(&self) -> &V {
        unsafe { &**(self.0 as *const *const V) }
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        unsafe { (self.vtable::<Unknown>().release)(self.0) };
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn check(hr: HRESULT) -> Result<(), String> {
    if hr < 0 { Err(format!("the file dialog failed (HRESULT {hr:#010x})")) } else { Ok(()) }
}

fn init() {
    unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
}

fn create(class: &GUID, iid: &GUID) -> Result<Com, String> {
    let mut object = null_mut();
    check(unsafe { CoCreateInstance(class, null_mut(), CLSCTX_INPROC_SERVER, iid, &mut object) })?;
    if object.is_null() {
        return Err("the file dialog did not start".to_owned());
    }
    Ok(Com(object))
}

fn pattern(glob: &str) -> Option<String> {
    let extension = glob.strip_prefix("*.")?;
    let plain = !extension.is_empty() && !extension.contains(['*', '?', '[', '/', '\\', ';']);
    plain.then(|| glob.to_owned())
}

fn specs(filters: &[FileFilter]) -> Option<Vec<(String, String)>> {
    let mut specs = Vec::new();
    for filter in filters {
        if !filter.mimes.is_empty() {
            return None;
        }
        let patterns = filter.globs.iter().map(|glob| pattern(glob)).collect::<Option<Vec<_>>>()?;
        if patterns.is_empty() {
            return None;
        }
        let name = if filter.name.is_empty() { patterns.join(";") } else { filter.name.clone() };
        specs.push((name, patterns.join(";")));
    }
    (!specs.is_empty()).then_some(specs)
}

fn configure(dialog: &Com, options: u32, title: &str, filters: &[FileFilter]) -> Result<(), String> {
    let vtable = dialog.vtable::<FileDialog>();
    let title = wide(title);
    check(unsafe { (vtable.set_options)(dialog.0, options) })?;
    check(unsafe { (vtable.set_title)(dialog.0, title.as_ptr()) })?;
    let Some(specs) = specs(filters) else { return Ok(()) };
    let names: Vec<Vec<u16>> = specs.iter().map(|(name, _)| wide(name)).collect();
    let patterns: Vec<Vec<u16>> = specs.iter().map(|(_, pattern)| wide(pattern)).collect();
    let items: Vec<COMDLG_FILTERSPEC> =
        names.iter().zip(&patterns).map(|(name, pattern)| COMDLG_FILTERSPEC { pszName: name.as_ptr(), pszSpec: pattern.as_ptr() }).collect();
    check(unsafe { (vtable.set_file_types)(dialog.0, items.len() as u32, items.as_ptr()) })?;
    check(unsafe { (vtable.set_file_type_index)(dialog.0, 1) })
}

fn show(dialog: &Com, owner: HWND) -> Result<bool, String> {
    let hr = unsafe { (dialog.vtable::<FileDialog>().show)(dialog.0, owner) };
    if hr == CANCELLED {
        return Ok(false);
    }
    check(hr).map(|()| true)
}

fn display_path(item: &Com) -> Result<PathBuf, String> {
    let mut name: PWSTR = null_mut();
    check(unsafe { (item.vtable::<ShellItem>().get_display_name)(item.0, SIGDN_FILESYSPATH, &mut name) })?;
    if name.is_null() {
        return Err("the chosen item has no file system path".to_owned());
    }
    let mut length = 0;
    while unsafe { *name.add(length) } != 0 {
        length += 1;
    }
    let path = PathBuf::from(OsString::from_wide(unsafe { std::slice::from_raw_parts(name, length) }));
    unsafe { CoTaskMemFree(name.cast()) };
    Ok(path)
}

fn array_paths(array: &Com) -> Result<Vec<PathBuf>, String> {
    let vtable = array.vtable::<ShellItemArray>();
    let mut count = 0u32;
    check(unsafe { (vtable.get_count)(array.0, &mut count) })?;
    (0..count)
        .map(|index| {
            let mut item = null_mut();
            check(unsafe { (vtable.get_item_at)(array.0, index, &mut item) })?;
            display_path(&Com(item))
        })
        .collect()
}

pub(super) fn open(owner: HWND, request: &OpenRequest) -> Result<Option<Vec<PathBuf>>, String> {
    init();
    let dialog = create(&CLSID_FILE_OPEN_DIALOG, &IID_IFILE_OPEN_DIALOG)?;
    let mut options = FOS_FORCEFILESYSTEM | FOS_FILEMUSTEXIST;
    if request.multiple {
        options |= FOS_ALLOWMULTISELECT;
    }
    if request.directory {
        options |= FOS_PICKFOLDERS;
    }
    let filters: &[FileFilter] = if request.directory { &[] } else { &request.filters };
    configure(&dialog, options, &request.title, filters)?;
    if !show(&dialog, owner)? {
        return Ok(None);
    }
    let mut array = null_mut();
    check(unsafe { (dialog.vtable::<OpenDialog>().get_results)(dialog.0, &mut array) })?;
    let paths = array_paths(&Com(array))?;
    Ok((!paths.is_empty()).then_some(paths))
}

pub(super) fn save(owner: HWND, request: &SaveRequest) -> Result<Option<PathBuf>, String> {
    init();
    let dialog = create(&CLSID_FILE_SAVE_DIALOG, &IID_IFILE_SAVE_DIALOG)?;
    configure(&dialog, FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT, &request.title, &request.filters)?;
    if !request.name.is_empty() {
        let name = wide(&request.name);
        check(unsafe { (dialog.vtable::<FileDialog>().set_file_name)(dialog.0, name.as_ptr()) })?;
    }
    if !show(&dialog, owner)? {
        return Ok(None);
    }
    let mut item = null_mut();
    check(unsafe { (dialog.vtable::<FileDialog>().get_result)(dialog.0, &mut item) })?;
    display_path(&Com(item)).map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;

    const IID_ISHELL_ITEM: GUID = GUID::from_u128(0x43826d1e_e718_42ee_bc55_a1e261c37bfe);
    const IID_ISHELL_ITEM_ARRAY: GUID = GUID::from_u128(0xb63ea76d_1f85_456f_a19c_48159efa858b);

    fn filter(name: &str, globs: &[&str], mimes: &[&str]) -> FileFilter {
        FileFilter { name: name.to_owned(), globs: globs.iter().map(|g| (*g).to_owned()).collect(), mimes: mimes.iter().map(|m| (*m).to_owned()).collect() }
    }

    #[test]
    fn globs_become_wildcard_specs() {
        assert_eq!(specs(&[filter("Images", &["*.png", "*.JPG"], &[])]), Some(vec![("Images".to_owned(), "*.png;*.JPG".to_owned())]));
        assert_eq!(specs(&[filter("", &["*.txt"], &[])]), Some(vec![("*.txt".to_owned(), "*.txt".to_owned())]));
    }

    #[test]
    fn filters_that_cannot_be_mapped_allow_every_file() {
        assert_eq!(specs(&[]), None);
        assert_eq!(specs(&[filter("Any", &["*"], &[])]), None);
        assert_eq!(specs(&[filter("Report", &["report-*"], &[])]), None);
        assert_eq!(specs(&[filter("Mime", &[], &["text/plain"])]), None);
        assert_eq!(specs(&[filter("Mixed", &["*.png"], &["image/png"])]), None);
        assert_eq!(specs(&[filter("Empty", &[], &[])]), None);
        assert_eq!(specs(&[filter("Semicolon", &["*.a;b"], &[])]), None);
    }

    #[test]
    fn dialog_options_and_names_round_trip() {
        init();
        let dialog = create(&CLSID_FILE_SAVE_DIALOG, &IID_IFILE_SAVE_DIALOG).unwrap();
        let vtable = dialog.vtable::<FileDialog>();
        let options = FOS_FORCEFILESYSTEM | FOS_OVERWRITEPROMPT;
        check(unsafe { (vtable.set_options)(dialog.0, options) }).unwrap();
        let mut read = 0u32;
        check(unsafe { (vtable.get_options)(dialog.0, &mut read) }).unwrap();
        assert_eq!(read & options, options);
        let name = wide("report.txt");
        check(unsafe { (vtable.set_file_name)(dialog.0, name.as_ptr()) }).unwrap();
        let mut stored: PWSTR = null_mut();
        check(unsafe { (vtable.get_file_name)(dialog.0, &mut stored) }).unwrap();
        let text = unsafe { std::slice::from_raw_parts(stored, 10) };
        assert_eq!(String::from_utf16_lossy(text), "report.txt");
        unsafe { CoTaskMemFree(stored.cast()) };
    }

    #[test]
    fn shell_items_and_arrays_round_trip_native_paths() {
        init();
        let path = std::env::temp_dir().join(format!("acde-chooser-{}.txt", std::process::id()));
        std::fs::write(&path, "chooser").unwrap();
        let source = wide(path.to_str().unwrap());
        let mut item = null_mut();
        check(unsafe { windows_sys::Win32::UI::Shell::SHCreateItemFromParsingName(source.as_ptr(), null_mut(), &IID_ISHELL_ITEM, &mut item) }).unwrap();
        let item = Com(item);
        assert_eq!(display_path(&item).unwrap(), path);
        let mut array = null_mut();
        check(unsafe { windows_sys::Win32::UI::Shell::SHCreateShellItemArrayFromShellItem(item.0, &IID_ISHELL_ITEM_ARRAY, &mut array) }).unwrap();
        assert_eq!(array_paths(&Com(array)).unwrap(), vec![path.clone()]);
        std::fs::remove_file(path).unwrap();
    }
}
