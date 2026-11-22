const INFO_PLIST: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key>
	<string>org.dopame.Acde</string>
	<key>CFBundleName</key>
	<string>acde</string>
	<key>NSCameraUsageDescription</key>
	<string>An acde app asks to use the camera.</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>An acde app asks to use the microphone.</string>
</dict>
</plist>
"#;

fn main() {
    println!("cargo:rerun-if-env-changed=DEP_ACDE_NAPI_DEF");
    if let Ok(def) = std::env::var("DEP_ACDE_NAPI_DEF") {
        println!("cargo:rustc-link-arg-bins=/DEF:{def}");
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let plist = std::path::PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("Info.plist");
        std::fs::write(&plist, INFO_PLIST).expect("Info.plist");
        println!("cargo:rustc-link-arg-bins=-Wl,-sectcreate,__TEXT,__info_plist,{}", plist.display());
    }
}
