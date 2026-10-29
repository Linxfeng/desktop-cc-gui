use super::*;
use crate::usage_stats::pricing::parse_snapshot;
use crate::usage_stats::query::{run, validate};
use crate::usage_stats::store;
use crate::usage_stats::time::parse_iso_ms;
use crate::usage_stats::types::{QueryRequest, Tokens};

fn request(from: &str, to: &str, bucket: Option<&str>, tz: i32) -> QueryRequest {
    QueryRequest {
        from: from.to_string(),
        to: to.to_string(),
        bucket: bucket.map(str::to_string),
        tz_offset_minutes: tz,
    }
}

fn event(
    key: &str,
    ts: &str,
    model: &str,
    session: &str,
    project: &str,
    tokens: Tokens,
) -> UsageEvent {
    UsageEvent {
        key: key.to_string(),
        ts_ms: parse_iso_ms(ts).unwrap(),
        engine: "claude",
        model: model.to_string(),
        project: Some(project.to_string()),
        session_id: Some(session.to_string()),
        tokens,
    }
}

fn tokens(input: i64, output: i64, cache_read: i64, cache_write: i64) -> Tokens {
    Tokens {
        input,
        output,
        cache_read,
        cache_write,
        reasoning: 0,
    }
}

fn seeded(scratch: &Scratch, events: &[UsageEvent]) -> rusqlite::Connection {
    let conn = scratch.db();
    for e in events {
        store::upsert_event(&conn, e).unwrap();
    }
    conn
}

fn prices() -> crate::usage_stats::pricing::PriceTable {
    parse_snapshot(
        r#"{"source":"litellm","snapshotDate":"2026-10-01","models":{
            "claude-opus-4-5":[0.000005,0.000025,5e-7,0.00000625]}}"#,
        "bundled",
        None,
    )
    .unwrap()
}

#[test]
fn local_day_buckets_follow_the_offset_across_midnight() {
    let scratch = Scratch::new("query-tz");
    // UTC 15:30 / 16:30 on the 27th = 23:30 on the 27th / 00:30 on the 28th at UTC+8.
    let conn = seeded(
        &scratch,
        &[
            event(
                "a",
                "2026-10-27T15:30:00Z",
                "claude-opus-4-5",
                "s1",
                "/w",
                tokens(10, 1, 0, 0),
            ),
            event(
                "b",
                "2026-10-27T16:30:00Z",
                "claude-opus-4-5",
                "s1",
                "/w",
                tokens(20, 2, 0, 0),
            ),
        ],
    );
    let table = prices();
    let both = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-28", None, 480)).unwrap(),
        &table,
    )
    .unwrap();
    let buckets: Vec<(&str, i64)> = both
        .rows
        .iter()
        .map(|r| (r.bucket.as_str(), r.input))
        .collect();
    assert_eq!(buckets, [("2026-10-27", 10), ("2026-10-28", 20)]);
    assert_eq!(both.first_day.as_deref(), Some("2026-10-27"));

    let only_28 = run(
        &conn,
        &validate(&request("2026-10-28", "2026-10-28", None, 480)).unwrap(),
        &table,
    )
    .unwrap();
    assert_eq!(only_28.rows.len(), 1);
    assert_eq!(only_28.rows[0].input, 20);

    let hourly = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-28", Some("hour"), 480)).unwrap(),
        &table,
    )
    .unwrap();
    let hours: Vec<&str> = hourly.rows.iter().map(|r| r.bucket.as_str()).collect();
    assert_eq!(hours, ["2026-10-27T23", "2026-10-28T00"]);

    // Same data in UTC: one day, and UTC−5 moves the first day back.
    let utc = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-27", None, 0)).unwrap(),
        &table,
    )
    .unwrap();
    assert_eq!(utc.rows.len(), 1);
    assert_eq!(utc.rows[0].requests, 2);
    let west = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-27", None, -300)).unwrap(),
        &table,
    )
    .unwrap();
    assert_eq!(west.first_day.as_deref(), Some("2026-10-27"));
}

#[test]
fn rows_group_by_engine_model_and_project_with_session_counts() {
    let scratch = Scratch::new("query-group");
    let conn = seeded(
        &scratch,
        &[
            event(
                "a",
                "2026-10-27T01:00:00Z",
                "claude-opus-4-5",
                "s1",
                "/w",
                tokens(1, 10, 100, 1000),
            ),
            event(
                "b",
                "2026-10-27T02:00:00Z",
                "claude-opus-4-5",
                "s1",
                "/w",
                tokens(2, 20, 200, 2000),
            ),
            event(
                "c",
                "2026-10-27T03:00:00Z",
                "claude-opus-4-5",
                "s2",
                "/w",
                tokens(3, 30, 300, 3000),
            ),
            event(
                "d",
                "2026-10-27T04:00:00Z",
                "claude-opus-4-5",
                "s3",
                "/other",
                tokens(4, 40, 0, 0),
            ),
        ],
    );
    let response = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-27", Some("day"), 0)).unwrap(),
        &prices(),
    )
    .unwrap();
    assert_eq!(response.rows.len(), 2);
    let other = &response.rows[0];
    assert_eq!(
        (other.project.as_deref(), other.sessions, other.requests),
        (Some("/other"), 1, 1)
    );
    let w = &response.rows[1];
    assert_eq!(
        (w.project.as_deref(), w.sessions, w.requests),
        (Some("/w"), 2, 3)
    );
    assert_eq!(
        (w.input, w.output, w.cache_read, w.cache_write),
        (6, 60, 600, 6000)
    );
    let expected = 6.0 * 0.000005 + 60.0 * 0.000025 + 600.0 * 5e-7 + 6000.0 * 0.00000625;
    assert!((w.cost.unwrap() - expected).abs() < 1e-12);
    assert!(response.unknown_models.is_empty());
}

#[test]
fn unknown_model_has_no_cost_and_is_listed() {
    let scratch = Scratch::new("query-unknown");
    let conn = seeded(
        &scratch,
        &[
            event(
                "a",
                "2026-10-27T01:00:00Z",
                "claude-opus-4-5",
                "s1",
                "/w",
                tokens(1, 1, 0, 0),
            ),
            event(
                "b",
                "2026-10-27T01:00:00Z",
                "k3.1-pro",
                "s1",
                "/w",
                tokens(5, 5, 0, 0),
            ),
        ],
    );
    let response = run(
        &conn,
        &validate(&request("2026-10-27", "2026-10-27", None, 0)).unwrap(),
        &prices(),
    )
    .unwrap();
    let unknown = response
        .rows
        .iter()
        .find(|r| r.model == "k3.1-pro")
        .unwrap();
    assert_eq!(unknown.cost, None, "never priced with another model's rate");
    assert_eq!(response.unknown_models, ["k3.1-pro"]);
}

#[test]
fn empty_index_answers_with_no_rows() {
    let scratch = Scratch::new("query-empty");
    let conn = scratch.db();
    let response = run(
        &conn,
        &validate(&request("2026-01-01", "2026-12-31", None, 480)).unwrap(),
        &prices(),
    )
    .unwrap();
    assert!(response.rows.is_empty());
    assert_eq!(response.first_day, None);
}

#[test]
fn invalid_requests_are_rejected() {
    let bad = [
        request("2026-02-30", "2026-03-01", None, 0),
        request("2026-1-01", "2026-01-02", None, 0),
        request("2026-01-02", "2026-01-01", None, 0),
        request("2026-01-01", "2026-01-02", Some("week"), 0),
        request("2026-01-01", "2026-01-02", None, 2000),
        request("2026-01-01T00", "2026-01-02", None, 0),
    ];
    for req in bad {
        assert!(validate(&req).is_err(), "{req:?} should be rejected");
    }
    // 3700 days inclusive is the limit.
    assert!(validate(&request("2016-01-01", "2026-02-17", None, 0)).is_err());
    let ok = validate(&request("2016-01-01", "2026-02-16", Some("hour"), -720)).unwrap();
    assert!(ok.hourly);
    assert_eq!(ok.from_ms, parse_iso_ms("2016-01-01T12:00:00Z").unwrap());
    assert_eq!(ok.to_ms, parse_iso_ms("2026-02-17T12:00:00Z").unwrap());
}

#[test]
fn iso_timestamps_parse_with_zones_and_fractions() {
    assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        parse_iso_ms("2026-10-26T08:47:30.952Z"),
        Some(1_793_004_450_952)
    );
    assert_eq!(
        parse_iso_ms("2026-10-26T16:47:30.952123+08:00"),
        Some(1_793_004_450_952)
    );
    assert_eq!(
        parse_iso_ms("2026-10-26T03:47:30.952-0500"),
        Some(1_793_004_450_952)
    );
    assert_eq!(parse_iso_ms("2026-10-26T08:47:30"), Some(1_793_004_450_000));
    for bad in [
        "",
        "2026-10-26",
        "2026-13-01T00:00:00Z",
        "2026-10-26T08:47:30.Z",
        "2026-10-26T08:47:30Zjunk",
    ] {
        assert_eq!(parse_iso_ms(bad), None, "{bad}");
    }
}
