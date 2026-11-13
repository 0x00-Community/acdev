use std::cell::RefCell;

use encoding_rs::{CoderResult, Decoder, DecoderResult, Encoding};

use crate::host::bind;

struct Stream {
    decoder: Decoder,
    fatal: bool,
}

thread_local! {
    static STREAMS: RefCell<bind::Slab<Stream>> = RefCell::new(bind::Slab::default());
}

pub fn encoding_name(label: &str) -> Option<String> {
    Encoding::for_label_no_replacement(label.as_bytes()).map(|encoding| encoding.name().to_ascii_lowercase())
}

fn new_decoder(encoding: &'static Encoding, ignore_bom: bool) -> Decoder {
    match ignore_bom {
        true => encoding.new_decoder_without_bom_handling(),
        false => encoding.new_decoder_with_bom_removal(),
    }
}

fn feed(decoder: &mut Decoder, bytes: &[u8], last: bool, fatal: bool) -> Option<String> {
    let mut out = String::with_capacity(room(decoder, bytes.len(), fatal));
    let mut rest = bytes;
    loop {
        let read = match fatal {
            true => match decoder.decode_to_string_without_replacement(rest, &mut out, last) {
                (DecoderResult::InputEmpty, _) => return Some(out),
                (DecoderResult::Malformed(..), _) => return None,
                (DecoderResult::OutputFull, read) => read,
            },
            false => match decoder.decode_to_string(rest, &mut out, last) {
                (CoderResult::InputEmpty, _, _) => return Some(out),
                (CoderResult::OutputFull, read, _) => read,
            },
        };
        rest = &rest[read..];
        out.reserve(room(decoder, rest.len(), fatal).max(4));
    }
}

fn room(decoder: &Decoder, len: usize, fatal: bool) -> usize {
    let room = match fatal {
        true => decoder.max_utf8_buffer_length_without_replacement(len),
        false => decoder.max_utf8_buffer_length(len),
    };
    room.unwrap_or(len)
}

pub fn decode_once(label: &str, bytes: &[u8], fatal: bool, ignore_bom: bool) -> Option<Option<String>> {
    let encoding = Encoding::for_label(if label.is_empty() { b"utf-8" } else { label.as_bytes() })?;
    Some(feed(&mut new_decoder(encoding, ignore_bom), bytes, true, fatal))
}

fn invalid_label(scope: &mut v8::PinScope, label: &str) {
    bind::throw_range_error(scope, &format!("The encoding label provided ('{label}') is invalid."));
}

fn invalid_data(scope: &mut v8::PinScope) {
    bind::throw_type_error(scope, "The encoded data was not valid.");
}

pub fn name(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    match encoding_name(&bind::arg_string(scope, &args, 0)) {
        Some(name) => rv.set(bind::string(scope, &name).into()),
        None => rv.set_null(),
    }
}

pub fn decode(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let label = bind::arg_string(scope, &args, 1);
    let fatal = bind::arg_bool(scope, &args, 2);
    let ignore_bom = bind::arg_bool(scope, &args, 3);
    let Some(decoded) = bind::with_bytes(args.get(0), |bytes| decode_once(&label, bytes, fatal, ignore_bom)) else {
        return bind::throw_type_error(scope, "decode: not an ArrayBuffer or a view");
    };
    match decoded {
        None => invalid_label(scope, &label),
        Some(None) => invalid_data(scope),
        Some(Some(out)) => rv.set(bind::string(scope, &out).into()),
    }
}

pub fn open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let label = bind::arg_string(scope, &args, 0);
    let Some(encoding) = Encoding::for_label_no_replacement(label.as_bytes()) else {
        return invalid_label(scope, &label);
    };
    let stream = Stream { decoder: new_decoder(encoding, bind::arg_bool(scope, &args, 2)), fatal: bind::arg_bool(scope, &args, 1) };
    rv.set_uint32(STREAMS.with(|s| s.borrow_mut().add(stream)));
}

pub fn chunk(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let id = bind::arg_u32(scope, &args, 0);
    let last = bind::arg_bool(scope, &args, 2);
    let Some(mut stream) = STREAMS.with(|s| s.borrow_mut().remove(&id)) else {
        return bind::throw_type_error(scope, "decodeChunk: no such decoder");
    };
    let Some(decoded) = bind::with_bytes(args.get(1), |bytes| feed(&mut stream.decoder, bytes, last, stream.fatal)) else {
        STREAMS.with(|s| s.borrow_mut().insert(id, stream));
        return bind::throw_type_error(scope, "decodeChunk: not an ArrayBuffer or a view");
    };
    let Some(out) = decoded else {
        return invalid_data(scope);
    };
    if !last {
        STREAMS.with(|s| s.borrow_mut().insert(id, stream));
    }
    rv.set(bind::string(scope, &out).into());
}

pub fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let id = bind::arg_u32(scope, &args, 0);
    STREAMS.with(|s| s.borrow_mut().remove(&id));
}

pub fn clear() {
    drop(STREAMS.with(|s| std::mem::take(&mut *s.borrow_mut())));
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLES: &[(&str, &[u8], &str)] = &[
        ("gb18030", &[0xc4, 0xe3, 0xba, 0xc3, 0x81, 0x30, 0x81, 0x30], "你好\u{80}"),
        ("gbk", &[0xc4, 0xe3, 0xba, 0xc3], "你好"),
        ("big5", &[0xa4, 0xa4, 0xa4, 0xe5], "中文"),
        ("shift_jis", &[0x93, 0xfa, 0x96, 0x7b], "日本"),
        ("euc-kr", &[0xc7, 0xd1, 0xb1, 0xb9], "한국"),
        ("euc-jp", &[0xc6, 0xfc, 0xcb, 0xdc], "日本"),
        ("iso-2022-jp", &[0x1b, 0x24, 0x42, 0x46, 0x7c, 0x4b, 0x5c, 0x1b, 0x28, 0x42], "日本"),
        ("windows-1250", &[0xe8], "č"),
        ("windows-1251", &[0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2], "Привет"),
        ("windows-1252", &[0x80], "€"),
        ("windows-1253", &[0xe1], "α"),
        ("utf-16be", &[0x4f, 0x60, 0x59, 0x7d], "你好"),
    ];

    #[test]
    fn every_listed_encoding_decodes_its_sample() {
        for &(label, bytes, text) in SAMPLES {
            assert_eq!(encoding_name(label).as_deref(), Some(label), "{label} is its own name");
            assert_eq!(decode_once(label, bytes, true, false), Some(Some(text.to_owned())), "{label}");
        }
    }

    #[test]
    fn labels_resolve_like_browsers() {
        for (label, name) in [("GBK ", "gbk"), ("x-gbk", "gbk"), ("sjis", "shift_jis"), ("ks_c_5601-1987", "euc-kr"), ("cp1251", "windows-1251")] {
            assert_eq!(encoding_name(label).as_deref(), Some(name), "{label}");
        }
        for (label, name) in [("latin1", "windows-1252"), ("ascii", "windows-1252"), ("utf-16", "utf-16le"), ("unicode-1-1-utf-8", "utf-8")] {
            assert_eq!(encoding_name(label).as_deref(), Some(name), "{label}");
        }
        for label in ["", "cp936", "nope", "iso-2022-kr", "replacement"] {
            assert_eq!(encoding_name(label), None, "{label:?} is a RangeError");
        }
    }

    #[test]
    fn a_stream_keeps_a_character_split_across_chunks() {
        for &(label, bytes, text) in SAMPLES {
            let encoding = Encoding::for_label(label.as_bytes()).expect("label");
            for cut in 0..=bytes.len() {
                let mut decoder = new_decoder(encoding, false);
                let head = feed(&mut decoder, &bytes[..cut], false, true).expect("head");
                let tail = feed(&mut decoder, &bytes[cut..], true, true).expect("tail");
                assert_eq!(head + &tail, text, "{label} cut at {cut}");
            }
        }
    }

    #[test]
    fn fatal_rejects_and_replacement_substitutes() {
        let truncated = &[0xc4, 0xe3, 0xba];
        assert_eq!(decode_once("gbk", truncated, true, false), Some(None));
        assert_eq!(decode_once("gbk", truncated, false, false), Some(Some("你\u{fffd}".to_owned())));
        assert_eq!(decode_once("nope", truncated, false, false), None);
    }

    #[test]
    fn the_bom_is_removed_unless_ignored() {
        let bytes = &[0xef, 0xbb, 0xbf, b'a'];
        assert_eq!(decode_once("utf-8", bytes, false, false), Some(Some("a".to_owned())));
        assert_eq!(decode_once("utf-8", bytes, false, true), Some(Some("\u{feff}a".to_owned())));
    }
}
