//! Opt-in sanity run against this machine's real CLI logs:
//!   cargo test usage_stats::tests::real_machine -- --ignored --nocapture
//! Logs are only read; the index goes to a scratch DB that is deleted after.

use super::Scratch;
use crate::usage_stats::pricing::load_preferred;
use crate::usage_stats::query::{run, validate};
use crate::usage_stats::scan::{self, ScanMode};
use crate::usage_stats::sources::default_specs;
use crate::usage_stats::types::QueryRequest;
use std::collections::BTreeMap;

/// requests, input, output, cache read, cache write, cost
type Totals = (i64, i64, i64, i64, i64, f64);

#[test]
#[ignore = "reads the real HOME's CLI logs (read-only); run manually"]
fn real_machine_sanity() {
    let specs = {
        // Resolve roots while no other test is steering HOME.
        let _lock = crate::paths::HOME_ENV_LOCK.lock();
        default_specs()
    };
    let scratch = Scratch::new("real-machine");
    let mut conn = scratch.db();
    let first = scan::run(&mut conn, &specs, ScanMode::Incremental, &mut |_| {}).unwrap();
    let second = scan::run(&mut conn, &specs, ScanMode::Incremental, &mut |_| {}).unwrap();
    println!("first scan: {first:?}");
    // Live sessions (including the one running this test) keep appending,
    // so a second pass may pick up a handful of new responses.
    println!("second scan (only files appended since): {second:?}");
    let incremental_events = crate::usage_stats::store::event_count(&conn);
    let full = scan::run(&mut conn, &specs, ScanMode::Full, &mut |_| {}).unwrap();
    let rebuilt_events = crate::usage_stats::store::event_count(&conn);
    println!(
        "full rebuild: {full:?}; events incremental={incremental_events} rebuilt={rebuilt_events}"
    );
    assert!(
        (rebuilt_events - incremental_events).abs() <= 50,
        "incremental and full rebuild agree"
    );

    let req = QueryRequest {
        from: "2020-01-01".into(),
        to: "2030-01-01".into(),
        bucket: None,
        tz_offset_minutes: 480,
    };
    let prices = load_preferred(&scratch.path("no-online-copy.json"));
    let response = run(&conn, &validate(&req).unwrap(), &prices).unwrap();
    let mut by_model: BTreeMap<(String, String), Totals> = BTreeMap::new();
    for row in &response.rows {
        let entry = by_model
            .entry((row.engine.clone(), row.model.clone()))
            .or_default();
        entry.0 += row.requests;
        entry.1 += row.input;
        entry.2 += row.output;
        entry.3 += row.cache_read;
        entry.4 += row.cache_write;
        entry.5 += row.cost.unwrap_or(0.0);
    }
    println!("first day: {:?}", response.first_day);
    for ((engine, model), (req, input, output, cr, cw, cost)) in &by_model {
        println!("{engine:7} {model:32} req={req:6} in={input:10} out={output:9} cr={cr:12} cw={cw:10} ${cost:.2}");
    }
    println!("unknown models: {:?}", response.unknown_models);
}
