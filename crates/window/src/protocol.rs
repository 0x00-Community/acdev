#![allow(non_upper_case_globals, non_camel_case_types, unused_imports, clippy::all)]

use wayland_client;
use wayland_client::protocol::*;

mod interfaces {
    use wayland_client::protocol::__interfaces::*;
    wayland_scanner::generate_interfaces!("../model/protocol/acde-window.xml");
}

use self::interfaces::*;

wayland_scanner::generate_client_code!("../model/protocol/acde-window.xml");
