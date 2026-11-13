use std::cell::RefCell;
use std::sync::Arc;

use acde_storage::Lease;
use acde_storage::idb::{Direction, Error, ErrorKind, Event, Fetch, Id, Idb, Mode, Op, Range, Record, Reply, Schema, Sink, Source};

use crate::bind;
use crate::rt::{self, Msg};

struct State {
    lease: Lease,
    owner: u64,
    sink: Sink,
    on_event: Option<v8::Global<v8::Function>>,
}

thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

pub fn install(scope: &mut v8::PinScope, storage: v8::Local<v8::Object>, lease: Lease) {
    let owner = acde_storage::idb::new_owner();
    let tx = rt::current().sender();
    let sink: Sink = Arc::new(move |event| _ = tx.send(Msg::Task(Box::new(move |scope| deliver(scope, event)))));
    STATE.with(|s| *s.borrow_mut() = Some(State { lease, owner, sink, on_event: None }));
    let idb = v8::Object::new(scope);
    crate::methods!(scope, idb,
        "onEvent" => on_event,
        "open" => open,
        "deleteDatabase" => delete_database,
        "databases" => databases,
        "begin" => begin,
        "commit" => commit,
        "abort" => abort,
        "close" => close,
        "acknowledge" => acknowledge,
        "put" => put,
        "remove" => remove,
        "clear" => clear_store,
        "get" => get,
        "count" => count,
        "cursor" => cursor,
        "createStore" => create_store,
        "deleteStore" => delete_store,
        "renameStore" => rename_store,
        "createIndex" => create_index,
        "indexEntries" => index_entries,
        "deleteIndex" => delete_index,
        "renameIndex" => rename_index,
    );
    bind::set(scope, storage, "idb", idb.into());
}

pub fn clear() {
    let state = STATE.with(|s| s.borrow_mut().take());
    if let Some(state) = &state
        && let Some(idb) = state.lease.idb_if_open()
    {
        idb.owner_gone(state.owner);
    }
    drop(state);
}

fn with_idb<R>(scope: &mut v8::PinScope, f: impl FnOnce(&Idb, u64, &Sink) -> R) -> Option<R> {
    let found = STATE.with(|s| s.borrow().as_ref().map(|s| (s.lease.clone(), s.owner, s.sink.clone())));
    let Some((lease, owner, sink)) = found else {
        bind::throw_error(scope, "indexedDB: released");
        return None;
    };
    Some(f(lease.idb(), owner, &sink))
}

fn utf16(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Box<[u16]> {
    let Some(text) = value.to_string(scope) else { return Box::default() };
    let mut units = vec![0u16; text.length()];
    text.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    units.into()
}

fn js_text<'s>(scope: &mut v8::PinScope<'s, '_>, text: &[u16]) -> v8::Local<'s, v8::Value> {
    v8::String::new_from_two_byte(scope, text, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into)
}

struct Args<'a, 's, 'i, 'v> {
    scope: &'a mut v8::PinScope<'s, 'i>,
    args: &'a v8::FunctionCallbackArguments<'v>,
    owner: u64,
}

impl<'s> Args<'_, 's, '_, '_> {
    fn number(&mut self, i: i32) -> f64 {
        self.args.get(i).number_value(self.scope).unwrap_or(0.0)
    }

    fn uint(&mut self, i: i32) -> u64 {
        let n = self.number(i);
        if n.is_finite() && n >= 0.0 { n as u64 } else { 0 }
    }

    fn int(&mut self, i: i32) -> i64 {
        self.number(i) as i64
    }

    fn id(&mut self, i: i32) -> Id {
        Id { owner: self.owner, local: self.uint(i) }
    }

    fn flag(&mut self, i: i32) -> bool {
        self.args.get(i).boolean_value(self.scope)
    }

    fn bytes(&mut self, i: i32) -> Option<Vec<u8>> {
        bind::bytes(self.args.get(i))
    }

    fn text(&mut self, i: i32) -> Box<[u16]> {
        utf16(self.scope, self.args.get(i))
    }

    fn string(&mut self, i: i32) -> Option<String> {
        let value = self.args.get(i);
        value.is_string().then(|| value.to_rust_string_lossy(self.scope))
    }

    fn range(&mut self, i: i32) -> Range {
        let lower = self.bytes(i).map(|key| (key, self.flag(i + 1)));
        let upper = self.bytes(i + 2).map(|key| (key, self.flag(i + 3)));
        Range { lower, upper }
    }

    fn source(&mut self, i: i32) -> Source {
        let id = self.int(i + 1);
        if self.flag(i) { Source::Index(id) } else { Source::Store(id) }
    }

    fn direction(&mut self, i: i32) -> Direction {
        match self.uint(i) {
            1 => Direction::NextUnique,
            2 => Direction::Prev,
            3 => Direction::PrevUnique,
            _ => Direction::Next,
        }
    }

    fn list(&mut self, i: i32) -> Vec<v8::Local<'s, v8::Value>> {
        let Ok(array) = v8::Local::<v8::Array>::try_from(self.args.get(i)) else { return Vec::new() };
        (0..array.length()).filter_map(|n| array.get_index(self.scope, n)).collect()
    }

    fn pairs(&mut self, i: i32) -> Vec<(v8::Local<'s, v8::Value>, v8::Local<'s, v8::Value>)> {
        let items = self.list(i);
        items.as_chunks::<2>().0.iter().map(|[a, b]| (*a, *b)).collect()
    }
}

macro_rules! args {
    ($scope:ident, $args:ident) => {{
        let owner = STATE.with(|s| s.borrow().as_ref().map(|s| s.owner));
        let Some(owner) = owner else {
            return bind::throw_error($scope, "indexedDB: released");
        };
        Args { scope: $scope, args: &$args, owner }
    }};
}

fn send(a: &mut Args, body: Op) {
    let (db, tx, op) = (a.uint(0), a.id(1), a.uint(2));
    with_idb(a.scope, move |idb, _, _| idb.op(db, tx, op, body));
}

fn on_event(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let callback = v8::Local::<v8::Function>::try_from(args.get(0)).ok().map(|f| v8::Global::new(scope, f));
    STATE.with(|s| {
        if let Some(state) = s.borrow_mut().as_mut() {
            state.on_event = callback;
        }
    });
}

fn open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let name = a.text(0);
    let req = a.id(1);
    let version = (!a.args.get(2).is_undefined()).then(|| a.uint(2));
    with_idb(a.scope, move |idb, _, sink| idb.open_database(&name, req, version, sink.clone()));
}

fn delete_database(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let name = a.text(0);
    let req = a.id(1);
    with_idb(a.scope, move |idb, _, sink| idb.delete_database(&name, req, sink.clone()));
}

fn databases(scope: &mut v8::PinScope, _: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(list) = with_idb(scope, |idb, _, _| idb.databases()) else { return };
    match list {
        Ok(list) => {
            let items: Vec<v8::Local<v8::Value>> = list
                .iter()
                .map(|(name, version)| {
                    let pair = [js_text(scope, name), v8::Number::new(scope, *version as f64).into()];
                    v8::Array::new_with_elements(scope, &pair).into()
                })
                .collect();
            rv.set(v8::Array::new_with_elements(scope, &items).into());
        }
        Err(e) => bind::throw_error(scope, &format!("UnknownError: {}", e.message)),
    }
}

fn begin(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let db = a.uint(0);
    let tx = a.id(1);
    let conn = a.id(2);
    let scope_ids: Vec<i64> = {
        let items = a.list(3);
        items.iter().map(|v| v.integer_value(a.scope).unwrap_or(0)).collect()
    };
    let mode = if a.uint(4) == 1 { Mode::ReadWrite } else { Mode::ReadOnly };
    with_idb(a.scope, move |idb, _, _| idb.begin(db, tx, conn, scope_ids, mode));
}

fn commit(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let (db, tx) = (a.uint(0), a.id(1));
    with_idb(a.scope, move |idb, _, _| idb.commit(db, tx));
}

fn abort(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let (db, tx) = (a.uint(0), a.id(1));
    with_idb(a.scope, move |idb, _, _| idb.abort(db, tx));
}

fn close(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let (db, conn) = (a.uint(0), a.id(1));
    with_idb(a.scope, move |idb, _, _| idb.close(db, conn));
}

fn acknowledge(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let (db, conn) = (a.uint(0), a.id(1));
    with_idb(a.scope, move |idb, _, _| idb.acknowledge(db, conn));
}

fn put(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let store = a.int(3);
    let key = a.bytes(4).unwrap_or_default();
    let value = a.bytes(5).unwrap_or_default();
    let indexes: Vec<(i64, Vec<u8>)> = {
        let pairs = a.pairs(6);
        pairs.iter().map(|(index, key)| (index.integer_value(a.scope).unwrap_or(0), bind::bytes(*key).unwrap_or_default())).collect()
    };
    let overwrite = a.flag(7);
    let generator = (!a.args.get(8).is_undefined()).then(|| a.number(8));
    send(&mut a, Op::Put { store, key, value, indexes, overwrite, generator });
}

fn remove(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let store = a.int(3);
    let range = a.range(4);
    send(&mut a, Op::Delete { store, range });
}

fn clear_store(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let store = a.int(3);
    send(&mut a, Op::Clear { store });
}

fn get(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let source = a.source(3);
    let range = a.range(5);
    let fetch = if a.flag(9) { Fetch::Records } else { Fetch::Keys };
    let count = Some(a.uint(10)).filter(|n| *n > 0).map(|n| n.min(u64::from(u32::MAX)) as u32);
    let direction = a.direction(11);
    send(&mut a, Op::Get { source, range, fetch, count, direction });
}

fn count(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let source = a.source(3);
    let range = a.range(5);
    send(&mut a, Op::Count { source, range });
}

fn cursor(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let source = a.source(3);
    let range = a.range(5);
    let direction = a.direction(9);
    let position = a.bytes(10).map(|key| (key, a.bytes(11)));
    let key = a.bytes(12);
    let primary_key = a.bytes(13);
    let advance = a.uint(14).clamp(1, u64::from(u32::MAX)) as u32;
    let values = a.flag(15);
    send(&mut a, Op::Cursor { source, range, direction, position, key, primary_key, advance, values });
}

fn create_store(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let id = a.int(3);
    let name = a.text(4);
    let key_path = a.string(5);
    let auto_increment = a.flag(6);
    send(&mut a, Op::CreateStore { id, name, key_path, auto_increment });
}

fn delete_store(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let store = a.int(3);
    send(&mut a, Op::DeleteStore { store });
}

fn rename_store(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let store = a.int(3);
    let name = a.text(4);
    send(&mut a, Op::RenameStore { store, name });
}

fn create_index(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let id = a.int(3);
    let store = a.int(4);
    let name = a.text(5);
    let key_path = a.string(6).unwrap_or_default();
    let unique = a.flag(7);
    let multi_entry = a.flag(8);
    send(&mut a, Op::CreateIndex { id, store, name, key_path, unique, multi_entry });
}

fn index_entries(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let index = a.int(3);
    let entries: Vec<(Vec<u8>, Vec<u8>)> = {
        let pairs = a.pairs(4);
        pairs.iter().map(|(key, pk)| (bind::bytes(*key).unwrap_or_default(), bind::bytes(*pk).unwrap_or_default())).collect()
    };
    send(&mut a, Op::IndexEntries { index, entries });
}

fn delete_index(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let index = a.int(3);
    send(&mut a, Op::DeleteIndex { index });
}

fn rename_index(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _: v8::ReturnValue) {
    let mut a = args!(scope, args);
    let index = a.int(3);
    let name = a.text(4);
    send(&mut a, Op::RenameIndex { index, name });
}

fn error_name(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::Constraint => "ConstraintError",
        ErrorKind::Version => "VersionError",
        ErrorKind::Abort => "AbortError",
        ErrorKind::Unknown => "UnknownError",
    }
}

fn error<'s>(scope: &mut v8::PinScope<'s, '_>, error: &Error) -> v8::Local<'s, v8::Value> {
    crate::js_object!(scope, {"name" => error_name(error.kind), "message" => error.message.as_str()}).into()
}

fn num<'s>(scope: &mut v8::PinScope<'s, '_>, n: f64) -> v8::Local<'s, v8::Value> {
    v8::Number::new(scope, n).into()
}

fn schema<'s>(scope: &mut v8::PinScope<'s, '_>, schema: &Schema) -> v8::Local<'s, v8::Value> {
    let stores: Vec<v8::Local<v8::Value>> = schema
        .stores
        .iter()
        .map(|store| {
            let indexes: Vec<v8::Local<v8::Value>> = store
                .indexes
                .iter()
                .map(|index| {
                    let fields = [
                        ("id", num(scope, index.id as f64)),
                        ("name", js_text(scope, &index.name)),
                        ("keyPath", bind::string(scope, &index.key_path).into()),
                        ("unique", v8::Boolean::new(scope, index.unique).into()),
                        ("multiEntry", v8::Boolean::new(scope, index.multi_entry).into()),
                    ];
                    bind::object(scope, &fields).into()
                })
                .collect();
            let key_path = match &store.key_path {
                Some(path) => bind::string(scope, path).into(),
                None => v8::null(scope).into(),
            };
            let fields = [
                ("id", num(scope, store.id as f64)),
                ("name", js_text(scope, &store.name)),
                ("keyPath", key_path),
                ("autoIncrement", v8::Boolean::new(scope, store.auto_increment).into()),
                ("generator", num(scope, store.generator)),
                ("indexes", v8::Array::new_with_elements(scope, &indexes).into()),
            ];
            bind::object(scope, &fields).into()
        })
        .collect();
    let fields = [("version", num(scope, schema.version as f64)), ("stores", v8::Array::new_with_elements(scope, &stores).into())];
    bind::object(scope, &fields).into()
}

fn bytes<'s>(scope: &mut v8::PinScope<'s, '_>, data: Option<&Vec<u8>>) -> v8::Local<'s, v8::Value> {
    match data {
        Some(data) => bind::uint8_array(scope, data.clone()).into(),
        None => v8::null(scope).into(),
    }
}

fn records<'s>(scope: &mut v8::PinScope<'s, '_>, records: &[Record]) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> = records
        .iter()
        .map(|r| {
            let fields = [("key", bytes(scope, Some(&r.key))), ("primaryKey", bytes(scope, Some(&r.primary_key))), ("value", bytes(scope, r.value.as_ref()))];
            bind::object(scope, &fields).into()
        })
        .collect();
    v8::Array::new_with_elements(scope, &items).into()
}

fn version<'s>(scope: &mut v8::PinScope<'s, '_>, version: Option<u64>) -> v8::Local<'s, v8::Value> {
    match version {
        Some(v) => num(scope, v as f64),
        None => v8::null(scope).into(),
    }
}

fn event<'s>(scope: &mut v8::PinScope<'s, '_>, event: &Event) -> v8::Local<'s, v8::Object> {
    let id = |scope: &mut v8::PinScope<'s, '_>, id: &Id| num(scope, id.local as f64);
    let fields: Vec<(&str, v8::Local<v8::Value>)> = match event {
        Event::Opened { req, db, conn, schema: s } => {
            vec![
                ("type", bind::string(scope, "opened").into()),
                ("req", id(scope, req)),
                ("db", num(scope, *db as f64)),
                ("conn", id(scope, conn)),
                ("schema", schema(scope, s)),
            ]
        }
        Event::Upgrade { req, db, conn, tx, old, schema: s } => vec![
            ("type", bind::string(scope, "upgrade").into()),
            ("req", id(scope, req)),
            ("db", num(scope, *db as f64)),
            ("conn", id(scope, conn)),
            ("tx", id(scope, tx)),
            ("old", num(scope, *old as f64)),
            ("schema", schema(scope, s)),
        ],
        Event::OpenFailed { req, error: e } => vec![("type", bind::string(scope, "openFailed").into()), ("req", id(scope, req)), ("error", error(scope, e))],
        Event::Blocked { req, old, new } => {
            vec![("type", bind::string(scope, "blocked").into()), ("req", id(scope, req)), ("old", num(scope, *old as f64)), ("new", version(scope, *new))]
        }
        Event::VersionChange { conn, old, new } => {
            vec![
                ("type", bind::string(scope, "versionchange").into()),
                ("conn", id(scope, conn)),
                ("old", num(scope, *old as f64)),
                ("new", version(scope, *new)),
            ]
        }
        Event::Deleted { req, old } => vec![("type", bind::string(scope, "deleted").into()), ("req", id(scope, req)), ("old", num(scope, *old as f64))],
        Event::Started { tx, generators } => {
            let list: Vec<v8::Local<v8::Value>> = generators
                .iter()
                .map(|(store, n)| {
                    let pair = [num(scope, *store as f64), num(scope, *n)];
                    v8::Array::new_with_elements(scope, &pair).into()
                })
                .collect();
            vec![("type", bind::string(scope, "started").into()), ("tx", id(scope, tx)), ("generators", v8::Array::new_with_elements(scope, &list).into())]
        }
        Event::Result { tx, op, reply } => {
            let mut fields = vec![("type", bind::string(scope, "result").into()), ("tx", id(scope, tx)), ("op", num(scope, *op as f64))];
            match reply {
                Reply::Done => {}
                Reply::Id(n) => fields.push(("id", num(scope, *n as f64))),
                Reply::Count(n) => fields.push(("count", num(scope, *n as f64))),
                Reply::Records(list) => fields.push(("records", records(scope, list))),
                Reply::Failed(e) => fields.push(("error", error(scope, e))),
            }
            fields
        }
        Event::Complete { tx } => vec![("type", bind::string(scope, "complete").into()), ("tx", id(scope, tx))],
        Event::Aborted { tx, error: e } => {
            let e = match e {
                Some(e) => error(scope, e),
                None => v8::null(scope).into(),
            };
            vec![("type", bind::string(scope, "aborted").into()), ("tx", id(scope, tx)), ("error", e)]
        }
        Event::ForcedClose { conn } => vec![("type", bind::string(scope, "forcedClose").into()), ("conn", id(scope, conn))],
    };
    bind::object(scope, &fields)
}

fn deliver(scope: &mut v8::PinScope, payload: Event) {
    let Some(callback) = STATE.with(|s| s.borrow().as_ref().and_then(|s| s.on_event.clone())) else { return };
    let object = event(scope, &payload);
    bind::call(scope, &callback, &[object.into()]);
}
