//! Calendar math without chrono: civil-date <-> day-number conversion
//! (Howard Hinnant's algorithms), strict `YYYY-MM-DD` parsing and the ISO-8601
//! timestamps the CLIs write.

pub(crate) const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub(crate) fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let m = i64::from(month);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + i64::from(day) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Inverse of [`days_from_civil`].
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub(crate) fn format_day(days: i64) -> String {
    let (y, m, d) = civil_from_days(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Strict `YYYY-MM-DD` → day number. Rejects impossible dates (2026-02-30)
/// by round-tripping through the inverse conversion.
pub(crate) fn parse_day(text: &str) -> Result<i64, String> {
    let bytes = text.as_bytes();
    let shape_ok = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit());
    if !shape_ok {
        return Err(format!("invalid date \"{text}\" (expected YYYY-MM-DD)"));
    }
    let year: i64 = text[0..4]
        .parse()
        .map_err(|_| format!("invalid date \"{text}\""))?;
    let month: u32 = text[5..7]
        .parse()
        .map_err(|_| format!("invalid date \"{text}\""))?;
    let day: u32 = text[8..10]
        .parse()
        .map_err(|_| format!("invalid date \"{text}\""))?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return Err(format!("invalid date \"{text}\""));
    }
    let days = days_from_civil(year, month, day);
    if civil_from_days(days) != (year, month, day) {
        return Err(format!("invalid date \"{text}\""));
    }
    Ok(days)
}

fn digits(bytes: &[u8], start: usize, len: usize) -> Option<i64> {
    let slice = bytes.get(start..start + len)?;
    slice.iter().try_fold(0i64, |acc, b| {
        b.is_ascii_digit().then(|| acc * 10 + i64::from(b - b'0'))
    })
}

/// `YYYY-MM-DDTHH:MM:SS[.fff…][Z|±HH:MM|±HHMM]` → epoch ms. A missing zone
/// is read as UTC (every CLI here writes `Z`).
pub(crate) fn parse_iso_ms(text: &str) -> Option<i64> {
    let b = text.trim().as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    if b[10] != b'T' && b[10] != b't' && b[10] != b' ' {
        return None;
    }
    let (year, month, day) = (digits(b, 0, 4)?, digits(b, 5, 2)?, digits(b, 8, 2)?);
    let (hour, minute, second) = (digits(b, 11, 2)?, digits(b, 14, 2)?, digits(b, 17, 2)?);
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let mut pos = 19;
    let mut millis = 0i64;
    if b.get(pos) == Some(&b'.') {
        pos += 1;
        let start = pos;
        while b.get(pos).is_some_and(u8::is_ascii_digit) {
            pos += 1;
        }
        let frac = &b[start..pos];
        if frac.is_empty() {
            return None;
        }
        for (i, digit) in frac.iter().take(3).enumerate() {
            millis += i64::from(digit - b'0') * [100, 10, 1][i];
        }
    }
    let offset_minutes = match b.get(pos) {
        None => 0,
        Some(b'Z') | Some(b'z') if pos + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let hours = digits(b, pos + 1, 2)?;
            let rest = &b[pos + 3..];
            let mins = match rest {
                [] => 0,
                [b':', ..] if rest.len() == 3 => digits(rest, 1, 2)?,
                _ if rest.len() == 2 => digits(rest, 0, 2)?,
                _ => return None,
            };
            let total = hours * 60 + mins;
            if *sign == b'+' {
                total
            } else {
                -total
            }
        }
        _ => return None,
    };
    let days = days_from_civil(year, month as u32, day as u32);
    let secs = days * 86_400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
    Some(secs * 1000 + millis)
}

/// Epoch-ms from a JSON number that may be seconds or milliseconds.
pub(crate) fn epoch_ms_from_number(value: f64) -> Option<i64> {
    if !value.is_finite() || value <= 0.0 {
        return None;
    }
    let ms = if value < 1e12 { value * 1000.0 } else { value };
    Some(ms.floor() as i64)
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Today's UTC date (`YYYY-MM-DD`), used to stamp downloaded price tables.
pub(crate) fn utc_today() -> String {
    format_day(now_ms().div_euclid(DAY_MS))
}

/// Local calendar day of `ts_ms` for a fixed UTC offset in minutes.
pub(crate) fn local_day(ts_ms: i64, tz_offset_minutes: i32) -> i64 {
    (ts_ms + i64::from(tz_offset_minutes) * 60_000).div_euclid(DAY_MS)
}
