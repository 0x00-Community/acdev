use acde_storage::Lease;
use acde_storage::caches::{Entry, Headers, Operation, Query};

use crate::{bind, offload};

thread_local! {
    static LEASE: std::cell::RefCell<Option<Lease>> = const { std::cell::RefCell::new(None) };
    static QUEUE: std::cell::RefCell<Option<std::rc::Rc<offload::Queue>>> = const { std::cell::RefCell::new(None) };
}

fn queue(scope: &mut v8::PinScope) -> Option<std::rc::Rc<offload::Queue>> {
    let existing = QUEUE.with(|q| q.borrow().clone());
    if existing.is_some() {
        return existing;
    }
    match offload::Queue::new("acde-caches") {
        Ok(queue) => {
            let queue = std::rc::Rc::new(queue);
            QUEUE.with(|q| *q.borrow_mut() = Some(queue.clone()));
            Some(queue)
        }
        Err(e) => {
            bind::throw_error(scope, &format!("caches: no thread ({e})"));
            None
        }
    }
}

pub fn install(scope: &mut v8::PinScope, storage: v8::Local<v8::Object>, lease: Lease) {
    LEASE.with(|l| *l.borrow_mut() = Some(lease));
    let caches = v8::Object::new(scope);
    crate::methods!(scope, caches,
        "names" => names,
        "has" => has,
        "open" => open,
        "delete" => delete,
        "query" => query,
        "batch" => batch,
    );
    bind::set(scope, storage, "caches", caches.into());
}

pub fn clear() {
    let lease = LEASE.with(|l| l.borrow_mut().take());
    let queue = QUEUE.with(|q| q.borrow_mut().take());
    drop((lease, queue));
}

fn lease(_: &v8::FunctionCallbackArguments) -> Option<Lease> {
    LEASE.with(|l| l.borrow().clone())
}

fn utf16(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Box<[u16]> {
    let Some(text) = value.to_string(scope) else { return Box::default() };
    let mut units = vec![0u16; text.length()];
    text.write_v2(scope, 0, &mut units, v8::WriteFlags::empty());
    units.into()
}

fn headers(scope: &mut v8::PinScope, value: Option<v8::Local<v8::Value>>) -> Headers {
    let Some(list) = value.and_then(|v| v8::Local::<v8::Array>::try_from(v).ok()) else { return Vec::new() };
    (0..list.length())
        .filter_map(|i| {
            let pair = v8::Local::<v8::Array>::try_from(list.get_index(scope, i)?).ok()?;
            let name = pair.get_index(scope, 0)?.to_rust_string_lossy(scope);
            let value = pair.get_index(scope, 1)?.to_rust_string_lossy(scope);
            Some((name, value))
        })
        .collect()
}

fn query_of(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Query> {
    let object = v8::Local::<v8::Object>::try_from(value).ok()?;
    let flag = |scope: &mut v8::PinScope, name: &str| bind::get(scope, object, name).is_some_and(|v| v.is_true());
    let list = bind::get(scope, object, "headers");
    Some(Query {
        url: bind::get_string(scope, object, "url").unwrap_or_default(),
        method: bind::get_string(scope, object, "method").unwrap_or_else(|| "GET".into()),
        headers: headers(scope, list),
        ignore_search: flag(scope, "ignoreSearch"),
        ignore_method: flag(scope, "ignoreMethod"),
        ignore_vary: flag(scope, "ignoreVary"),
    })
}

fn entry_of(scope: &mut v8::PinScope, value: v8::Local<v8::Value>) -> Option<Entry> {
    let object = v8::Local::<v8::Object>::try_from(value).ok()?;
    let request_headers = bind::get(scope, object, "requestHeaders");
    let response_headers = bind::get(scope, object, "responseHeaders");
    Some(Entry {
        url: bind::get_string(scope, object, "url")?,
        method: bind::get_string(scope, object, "method").unwrap_or_else(|| "GET".into()),
        request_headers: headers(scope, request_headers),
        response: bind::get_string(scope, object, "response")?,
        response_headers: headers(scope, response_headers),
        body: bind::get(scope, object, "body").and_then(bind::bytes).unwrap_or_default(),
    })
}

fn js_headers<'s>(scope: &mut v8::PinScope<'s, '_>, headers: &Headers) -> v8::Local<'s, v8::Value> {
    let items: Vec<v8::Local<v8::Value>> = headers
        .iter()
        .map(|(name, value)| {
            let pair = [bind::string(scope, name).into(), bind::string(scope, value).into()];
            v8::Array::new_with_elements(scope, &pair).into()
        })
        .collect();
    v8::Array::new_with_elements(scope, &items).into()
}

fn reject(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, message: &str) {
    let error = offload::failure(scope, message, None, "UnknownError");
    resolver.reject(scope, error);
}

fn settle_bool(scope: &mut v8::PinScope, resolver: v8::Local<v8::PromiseResolver>, value: Result<bool, String>) {
    match value {
        Ok(v) => {
            let v = v8::Boolean::new(scope, v).into();
            resolver.resolve(scope, v);
        }
        Err(e) => reject(scope, resolver, &e),
    }
}

fn names(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let Some(queue) = queue(scope) else { return };
    queue.run(
        scope,
        &mut rv,
        move || lease.caches().names().map_err(|e| e.to_string()),
        |scope, resolver, value| match value {
            Ok(names) => {
                let items: Vec<v8::Local<v8::Value>> = names
                    .iter()
                    .map(|n| v8::String::new_from_two_byte(scope, n, v8::NewStringType::Normal).map_or_else(|| v8::undefined(scope).into(), Into::into))
                    .collect();
                let list = v8::Array::new_with_elements(scope, &items).into();
                resolver.resolve(scope, list);
            }
            Err(e) => reject(scope, resolver, &e),
        },
    );
}

fn has(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let name = utf16(scope, args.get(0));
    let Some(queue) = queue(scope) else { return };
    queue.run(scope, &mut rv, move || lease.caches().has(&name).map_err(|e| e.to_string()), settle_bool);
}

fn open(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let name = utf16(scope, args.get(0));
    let Some(queue) = queue(scope) else { return };
    queue.run(
        scope,
        &mut rv,
        move || lease.caches().open_cache(&name).map_err(|e| e.to_string()),
        |scope, resolver, value| match value {
            Ok(id) => {
                let id = v8::Number::new(scope, id as f64).into();
                resolver.resolve(scope, id);
            }
            Err(e) => reject(scope, resolver, &e),
        },
    );
}

fn delete(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let name = utf16(scope, args.get(0));
    let Some(queue) = queue(scope) else { return };
    queue.run(scope, &mut rv, move || lease.caches().delete_cache(&name).map_err(|e| e.to_string()), settle_bool);
}

fn query(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let cache = args.get(0).is_number().then(|| args.get(0).integer_value(scope).unwrap_or(0));
    let wanted = query_of(scope, args.get(1));
    let first = args.get(2).is_true();
    let Some(queue) = queue(scope) else { return };
    queue.run(
        scope,
        &mut rv,
        move || lease.caches().query(cache, wanted.as_ref(), first).map_err(|e| e.to_string()),
        |scope, resolver, value| match value {
            Ok(entries) => {
                let items: Vec<v8::Local<v8::Value>> = entries
                    .into_iter()
                    .map(|e| {
                        let fields = [
                            ("url", bind::string(scope, &e.url).into()),
                            ("method", bind::string(scope, &e.method).into()),
                            ("requestHeaders", js_headers(scope, &e.request_headers)),
                            ("response", bind::string(scope, &e.response).into()),
                            ("responseHeaders", js_headers(scope, &e.response_headers)),
                            ("body", bind::uint8_array(scope, e.body).into()),
                        ];
                        bind::object(scope, &fields).into()
                    })
                    .collect();
                let list = v8::Array::new_with_elements(scope, &items).into();
                resolver.resolve(scope, list);
            }
            Err(e) => reject(scope, resolver, &e),
        },
    );
}

fn batch(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, mut rv: v8::ReturnValue) {
    let Some(lease) = lease(&args) else { return bind::throw_error(scope, "caches: released") };
    let cache = args.get(0).integer_value(scope).unwrap_or(0);
    let Ok(list) = v8::Local::<v8::Array>::try_from(args.get(1)) else { return bind::throw_type_error(scope, "caches.batch: a list of operations") };
    let mut operations = Vec::new();
    for i in 0..list.length() {
        let Some(item) = list.get_index(scope, i).and_then(|v| v8::Local::<v8::Object>::try_from(v).ok()) else { continue };
        let kind = bind::get_string(scope, item, "type").unwrap_or_default();
        let operation = match kind.as_str() {
            "delete" => bind::get(scope, item, "query").and_then(|q| query_of(scope, q)).map(Operation::Delete),
            "put" => bind::get(scope, item, "entry").and_then(|e| entry_of(scope, e)).map(Operation::Put),
            _ => None,
        };
        match operation {
            Some(operation) => operations.push(operation),
            None => return bind::throw_type_error(scope, "caches.batch: an operation is malformed"),
        }
    }
    let Some(queue) = queue(scope) else { return };
    queue.run(
        scope,
        &mut rv,
        move || lease.caches().batch(cache, &operations).map_err(|e| e.to_string()),
        |scope, resolver, value| match value {
            Ok(outcomes) => {
                let items: Vec<v8::Local<v8::Value>> = outcomes.into_iter().map(|b| v8::Boolean::new(scope, b).into()).collect();
                let list = v8::Array::new_with_elements(scope, &items).into();
                resolver.resolve(scope, list);
            }
            Err(e) => reject(scope, resolver, &e),
        },
    );
}
