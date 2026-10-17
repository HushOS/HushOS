//! The core's verdicts over stdin, for the differential test in
//! `packages/crypto/fuzz/differential.test.ts`: one JSON request per line,
//! `{"target": "...", "data": "<base64url>"}`, answered by one line, the
//! target's verdict (`{"ok":..}` or `{"skip":true}`), or `{"panic": "..."}`
//! when an invariant failed. `{"target": "accept-history", "data": ..}` and
//! `{"target": "roster-document", "data": ..}` turn cargo-fuzz `accept` and
//! `roster_build` bytes into the history or roster they stand for, so the web
//! can replay those corpora.

use arbitrary::{Arbitrary, Unstructured};
use hushos_core::base64url_decode;
use hushos_core_fuzz::structured::History;
use hushos_core_fuzz::targets::verdict;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

fn answer(request: &Value) -> Value {
    let (Some(target), Some(data)) = (request["target"].as_str(), request["data"].as_str()) else {
        return json!({ "error": "a request is {target, data}" });
    };
    let data = if data.is_empty() { Some(vec![]) } else { base64url_decode(data.into()).ok() };
    let Some(data) = data else {
        return json!({ "error": "data is not base64url" });
    };
    if target == "roster-document" {
        return match hushos_core_fuzz::structured::roster(&mut Unstructured::new(&data)) {
            Ok(roster) => json!({ "input": roster }),
            Err(_) => json!({ "skip": true }),
        };
    }
    if target == "accept-history" {
        return match History::arbitrary_take_rest(Unstructured::new(&data)) {
            Ok(history) => json!({ "input": history.input() }),
            Err(_) => json!({ "skip": true }),
        };
    }
    match catch_unwind(AssertUnwindSafe(|| verdict(target, &data))) {
        Ok(Some(verdict)) => verdict,
        Ok(None) => json!({ "error": format!("no target {target}") }),
        Err(panic) => {
            let message = panic
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| panic.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default();
            json!({ "panic": message })
        }
    }
}

fn main() {
    // A failed invariant is answered as a verdict, not printed.
    std::panic::set_hook(Box::new(|_| {}));
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(request) => answer(&request),
            Err(_) => json!({ "error": "a request is one JSON line" }),
        };
        writeln!(out, "{reply}").expect("stdout");
        out.flush().expect("stdout");
    }
}
