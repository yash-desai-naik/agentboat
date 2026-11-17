//! Timestamps. Transcripts write ISO 8601 UTC (`2026-11-16T09:37:02.050Z`); the UI works in Unix
//! milliseconds. A tiny parser instead of a date crate: the format is fixed.

use std::time::{SystemTime, UNIX_EPOCH};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// `YYYY-MM-DDTHH:MM:SS[.fff]Z` → Unix milliseconds. Offsets other than `Z` are not written by
/// Claude Code, so they are not handled (the time is read as UTC).
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19
        || b[4] != b'-'
        || b[7] != b'-'
        || b[10] != b'T'
        || b[13] != b':'
        || b[16] != b':'
    {
        return None;
    }
    let num = |r: std::ops::Range<usize>| -> Option<i64> { s.get(r)?.parse::<i64>().ok() };
    let (y, mo, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (h, mi, sec) = (num(11..13)?, num(14..16)?, num(17..19)?);
    let mut ms = 0;
    if b.len() > 20 && b[19] == b'.' {
        let digits: String = s[20..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .take(3)
            .collect();
        if !digits.is_empty() {
            ms = digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32);
        }
    }
    Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec) * 1000 + ms)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_transcript_timestamps() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:01.5Z"), Some(1500));
        // 2026-11-16T09:37:02.050Z, checked against JavaScript's Date.parse.
        assert_eq!(
            parse_iso_ms("2026-11-16T09:37:02.050Z"),
            Some(1_794_821_822_050)
        );
        assert_eq!(parse_iso_ms("garbage"), None);
    }
}
