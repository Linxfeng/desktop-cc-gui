//! `query` validation and aggregation: local-day range → UTC ms window,
//! SQL grouping, then per-row cost from the price table.

use super::pricing::PriceTable;
use super::store;
use super::time::{format_day, local_day, parse_day, DAY_MS};
use super::types::{QueryRequest, QueryResponse, Tokens, UsageStatRow};
use rusqlite::Connection;
use std::collections::BTreeSet;

const MAX_RANGE_DAYS: i64 = 3700;
/// Real UTC offsets span −12:00…+14:00; leave headroom, reject nonsense.
const MAX_TZ_OFFSET_MINUTES: i32 = 18 * 60;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ValidQuery {
    pub from_ms: i64,
    pub to_ms: i64,
    pub hourly: bool,
    pub tz_offset_minutes: i32,
}

pub(crate) fn validate(req: &QueryRequest) -> Result<ValidQuery, String> {
    if req.tz_offset_minutes.abs() > MAX_TZ_OFFSET_MINUTES {
        return Err(format!(
            "tzOffsetMinutes {} is out of range",
            req.tz_offset_minutes
        ));
    }
    let hourly = match req.bucket.as_deref().map(str::trim) {
        None | Some("") | Some("day") => false,
        Some("hour") => true,
        Some(other) => return Err(format!("unknown bucket \"{other}\" (expected day or hour)")),
    };
    let from = parse_day(req.from.trim())?;
    let to = parse_day(req.to.trim())?;
    if from > to {
        return Err(format!("from {} is after to {}", req.from, req.to));
    }
    if to - from + 1 > MAX_RANGE_DAYS {
        return Err(format!("range exceeds {MAX_RANGE_DAYS} days"));
    }
    let offset_ms = i64::from(req.tz_offset_minutes) * 60_000;
    Ok(ValidQuery {
        from_ms: from * DAY_MS - offset_ms,
        to_ms: (to + 1) * DAY_MS - offset_ms,
        hourly,
        tz_offset_minutes: req.tz_offset_minutes,
    })
}

/// Rows plus history start; `scanned_at` / `scanning` are filled in by the
/// caller, which owns the scan state.
pub(crate) fn run(
    conn: &Connection,
    query: &ValidQuery,
    prices: &PriceTable,
) -> Result<QueryResponse, String> {
    let groups = store::aggregate(
        conn,
        query.from_ms,
        query.to_ms,
        query.hourly,
        query.tz_offset_minutes,
    )
    .map_err(|e| format!("query usage: {e}"))?;
    let mut unknown = BTreeSet::new();
    let rows = groups
        .into_iter()
        .map(|g| {
            let tokens = Tokens {
                input: g.input,
                output: g.output,
                cache_read: g.cache_read,
                cache_write: g.cache_write,
                reasoning: g.reasoning,
            };
            let cost = prices.price(&g.model).map(|p| p.cost(&tokens));
            if cost.is_none() {
                unknown.insert(g.model.clone());
            }
            UsageStatRow {
                bucket: g.bucket,
                engine: g.engine,
                model: g.model,
                project: g.project,
                sessions: g.sessions,
                requests: g.requests,
                input: g.input,
                output: g.output,
                cache_read: g.cache_read,
                cache_write: g.cache_write,
                reasoning: g.reasoning,
                cost,
            }
        })
        .collect();
    let first_day = store::first_event_ms(conn)
        .map_err(|e| format!("query first day: {e}"))?
        .map(|ms| format_day(local_day(ms, query.tz_offset_minutes)));
    Ok(QueryResponse {
        rows,
        first_day,
        scanned_at: None,
        scanning: false,
        unknown_models: unknown.into_iter().collect(),
    })
}
