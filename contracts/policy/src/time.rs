//! Pure ISO 8601 parsing for the timestamps inside a 1Click quote.
//!
//! Accepted grammar, nothing else: `YYYY-MM-DDTHH:MM:SS` + optional `.` and 1-9 digits + `Z`.
//! Fractions are truncated to whole seconds. No offsets, no leap seconds, no years before 1970.

fn digits(b: &[u8]) -> Option<u64> {
    b.iter().try_fold(0u64, |acc, c| c.is_ascii_digit().then(|| acc * 10 + u64::from(c - b'0')))
}

fn is_leap(y: u64) -> bool {
    (y.is_multiple_of(4) && !y.is_multiple_of(100)) || y.is_multiple_of(400)
}

fn days_in_month(y: u64, m: u64) -> u64 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a valid proleptic Gregorian date (H. Hinnant's days_from_civil).
fn days_from_civil(y: u64, m: u64, d: u64) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Unix seconds of an ISO 8601 UTC timestamp, or `ERR_QUOTE_TIME_FORMAT`.
pub fn parse_iso_utc(s: &str) -> Result<u64, &'static str> {
    const ERR: &str = "ERR_QUOTE_TIME_FORMAT";
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return Err(ERR);
    }
    let field = |from: usize, to: usize| digits(&b[from..to]).ok_or(ERR);
    let (y, mo, d) = (field(0, 4)?, field(5, 7)?, field(8, 10)?);
    let (h, mi, se) = (field(11, 13)?, field(14, 16)?, field(17, 19)?);
    match &b[19..] {
        [b'Z'] => {}
        [b'.', frac @ .., b'Z'] if (1..=9).contains(&frac.len()) && digits(frac).is_some() => {}
        _ => return Err(ERR),
    }
    if y < 1970 || !(1..=12).contains(&mo) || d == 0 || d > days_in_month(y, mo) || h > 23 || mi > 59 || se > 59 {
        return Err(ERR);
    }
    Ok(days_from_civil(y, mo, d) * 86_400 + h * 3_600 + mi * 60 + se)
}
