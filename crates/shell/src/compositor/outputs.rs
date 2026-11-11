use std::path::PathBuf;

use serde_json::{Value, json};
use smithay::output::Output;

pub struct Edid {
    pub make: String,
    pub model: String,
    pub identifier: String,
}

pub struct Identity {
    pub edid: Option<String>,
}

pub fn edid(connector: &str) -> Option<Edid> {
    let suffix = format!("-{connector}");
    let entry = std::fs::read_dir("/sys/class/drm").ok()?.flatten().find(|e| e.file_name().to_string_lossy().ends_with(&suffix))?;
    parse(&std::fs::read(entry.path().join("edid")).ok()?)
}

fn parse(edid: &[u8]) -> Option<Edid> {
    if edid.len() < 128 || edid[..8] != [0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0] {
        return None;
    }
    let id = u16::from_be_bytes([edid[8], edid[9]]);
    let letter = |shift: u16| char::from(b'@' + ((id >> shift) & 0x1f) as u8);
    let make: String = [letter(10), letter(5), letter(0)].into_iter().collect();
    let product = u16::from_le_bytes([edid[10], edid[11]]);
    let serial = u32::from_le_bytes([edid[12], edid[13], edid[14], edid[15]]);
    let (week, year) = (edid[16], u32::from(edid[17]) + 1990);
    let (week, model_year) = if week == 0xff { (0, year) } else { (week, 0) };
    let year = if model_year == 0 { year } else { 0 };
    let model = edid[54..126]
        .chunks(18)
        .find(|d| d[..3] == [0, 0, 0] && d[3] == 0xfc)
        .map(|d| String::from_utf8_lossy(&d[5..18]).split('\n').next().unwrap_or("").trim().to_owned())
        .unwrap_or_default();
    let identifier = format!("{make} {product} {serial} {week} {year} {model_year}");
    Some(Edid { make, model, identifier })
}

fn file() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()).map(PathBuf::from).or_else(|| std::env::var_os("HOME").filter(|v| !v.is_empty()).map(|h| PathBuf::from(h).join(".config")))?;
    Some(base.join("acde").join("display.json"))
}

fn read() -> Value {
    file().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| json!({ "outputs": [] }))
}

fn edid_of(output: &Output) -> Option<String> {
    output.user_data().get::<Identity>().and_then(|i| i.edid.clone())
}

fn matches(entry: &Value, output: &Output, edid: Option<&str>) -> bool {
    match (edid, entry["edidIdentifier"].as_str()) {
        (Some(mine), Some(theirs)) => mine == theirs,
        _ => entry["connectorName"].as_str() == Some(output.name().as_str()),
    }
}

pub fn saved_scale(output: &Output) -> Option<i32> {
    let edid = edid_of(output);
    let config = read();
    let outputs = config["outputs"].as_array()?;
    let entry = outputs.iter().find(|e| matches(e, output, edid.as_deref()))?;
    entry["scale"].as_f64().map(|s| s.round() as i32).filter(|s| (1..=3).contains(s))
}

pub fn save_scale(output: &Output, scale: i32) -> Result<(), String> {
    let path = file().ok_or("no XDG_CONFIG_HOME or HOME")?;
    let edid = edid_of(output);
    let mut config = read();
    if !config["outputs"].is_array() {
        config["outputs"] = json!([]);
    }
    let outputs = config["outputs"].as_array_mut().expect("made an array above");
    let entry = match outputs.iter().position(|e| matches(e, output, edid.as_deref())) {
        Some(i) => &mut outputs[i],
        None => {
            outputs.push(json!({}));
            outputs.last_mut().expect("just pushed")
        }
    };
    entry["connectorName"] = json!(output.name());
    if let Some(edid) = edid {
        entry["edidIdentifier"] = json!(edid);
    }
    entry["scale"] = json!(scale);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = serde_json::to_vec_pretty(&config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("{}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::parse;

    #[test]
    fn reads_an_edid_like_kwin() {
        let mut edid = vec![0u8; 128];
        edid[..8].copy_from_slice(&[0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0]);
        edid[8..10].copy_from_slice(&[0x05, 0xe3]);
        edid[10..12].copy_from_slice(&9232u16.to_le_bytes());
        edid[12..16].copy_from_slice(&16843009u32.to_le_bytes());
        edid[16] = 16;
        edid[17] = 36;
        edid[54..59].copy_from_slice(&[0, 0, 0, 0xfc, 0]);
        edid[59..72].copy_from_slice(b"Q27G2G4\n     ");
        let e = parse(&edid).unwrap();
        assert_eq!(e.identifier, "AOC 9232 16843009 16 2026 0");
        assert_eq!((e.make.as_str(), e.model.as_str()), ("AOC", "Q27G2G4"));
    }
}
