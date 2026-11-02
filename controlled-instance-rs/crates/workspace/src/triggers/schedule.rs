use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use controlled_instance_protocol::{TriggerScheduleKind, TriggerSource};

pub fn next_schedule_time(source: &TriggerSource, now: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let TriggerSource::Schedule {
        schedule_kind,
        interval_ms,
        time_of_day,
        timezone,
        weekdays,
    } = source
    else {
        return None;
    };
    if *schedule_kind == TriggerScheduleKind::Interval {
        return Some(now + Duration::milliseconds(interval_ms.unwrap_or(1_000) as i64));
    }
    let timezone = timezone.as_deref()?.parse::<Tz>().ok()?;
    let (hour, minute) = parse_time(time_of_day.as_deref()?)?;
    let local_now = now.with_timezone(&timezone);
    let dates = match schedule_kind {
        TriggerScheduleKind::Interval => unreachable!(),
        TriggerScheduleKind::Daily => (0..=8)
            .filter_map(|offset| {
                local_now
                    .date_naive()
                    .checked_add_days(chrono::Days::new(offset))
            })
            .collect::<Vec<_>>(),
        TriggerScheduleKind::Weekly => {
            let allowed = weekdays.as_deref().unwrap_or_default();
            let mut dates = Vec::new();
            for offset in 0..=14 {
                let Some(date) = local_now
                    .date_naive()
                    .checked_add_days(chrono::Days::new(offset))
                else {
                    continue;
                };
                if allowed.contains(&(date.weekday().num_days_from_sunday() as u8)) {
                    dates.push(date);
                }
            }
            dates
        }
    };
    dates
        .into_iter()
        .filter_map(|date| local_candidate(timezone, date, hour, minute))
        .filter(|candidate| *candidate > now)
        .min()
}

fn local_candidate(timezone: Tz, date: NaiveDate, hour: u32, minute: u32) -> Option<DateTime<Utc>> {
    let naive = date.and_hms_opt(hour, minute, 0)?;
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(value) => Some(value.with_timezone(&Utc)),
        LocalResult::Ambiguous(earlier, later) => Some(earlier.min(later).with_timezone(&Utc)),
        LocalResult::None => None,
    }
}

fn parse_time(value: &str) -> Option<(u32, u32)> {
    let (hour, minute) = value.split_once(':')?;
    Some((hour.parse().ok()?, minute.parse().ok()?))
}

pub fn delay_until(next: DateTime<Utc>, now: DateTime<Utc>) -> std::time::Duration {
    let millis = (next - now).num_milliseconds().max(1_000) as u64;
    std::time::Duration::from_millis(millis)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Weekday;

    fn source(kind: TriggerScheduleKind) -> TriggerSource {
        TriggerSource::Schedule {
            schedule_kind: kind,
            interval_ms: None,
            time_of_day: Some("09:30".to_string()),
            timezone: Some("Asia/Shanghai".to_string()),
            weekdays: Some(vec![1, 3, 5]),
        }
    }

    #[test]
    fn daily_and_weekly_schedules_are_resolved_in_the_configured_timezone() {
        let now = DateTime::parse_from_rfc3339("2026-11-01T17:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let daily = next_schedule_time(&source(TriggerScheduleKind::Daily), now).expect("daily");
        assert_eq!(daily.to_rfc3339(), "2026-11-02T01:30:00+00:00");
        let weekly = next_schedule_time(&source(TriggerScheduleKind::Weekly), now).expect("weekly");
        assert_eq!(weekly.to_rfc3339(), "2026-11-02T01:30:00+00:00");
    }

    #[test]
    fn interval_uses_the_next_slot_after_the_supplied_time() {
        let now = DateTime::parse_from_rfc3339("2026-11-02T00:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let source = TriggerSource::Schedule {
            schedule_kind: TriggerScheduleKind::Interval,
            interval_ms: Some(5_000),
            time_of_day: None,
            timezone: None,
            weekdays: None,
        };
        assert_eq!(
            next_schedule_time(&source, now)
                .expect("interval")
                .to_rfc3339(),
            "2026-11-02T00:00:05+00:00"
        );
    }

    #[test]
    fn weekday_numbers_match_javascript_sunday_zero() {
        assert_eq!(Weekday::Sun.num_days_from_sunday(), 0);
        assert_eq!(Weekday::Sat.num_days_from_sunday(), 6);
    }
}
