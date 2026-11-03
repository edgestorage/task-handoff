use chrono::{DateTime, Datelike, Duration, LocalResult, NaiveDate, TimeZone, Utc};
use chrono_tz::Tz;
use controlled_instance_protocol::{TriggerScheduleKind, TriggerSource};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("trigger source is not a schedule")]
    NotSchedule,
    #[error("intervalMs must be greater than zero")]
    InvalidInterval,
    #[error("timezone is required")]
    MissingTimezone,
    #[error("unknown timezone {0:?}")]
    InvalidTimezone(String),
    #[error("timeOfDay must use HH:MM")]
    InvalidTimeOfDay,
    #[error("weekdays must contain at least one day")]
    MissingWeekdays,
    #[error("schedule has no upcoming occurrence")]
    NoUpcomingOccurrence,
}

pub fn next_schedule_time(
    source: &TriggerSource,
    now: DateTime<Utc>,
) -> Result<DateTime<Utc>, ScheduleError> {
    let TriggerSource::Schedule {
        schedule_kind,
        interval_ms,
        time_of_day,
        timezone,
        weekdays,
    } = source
    else {
        return Err(ScheduleError::NotSchedule);
    };
    if *schedule_kind == TriggerScheduleKind::Interval {
        let interval_ms = interval_ms
            .filter(|value| *value > 0)
            .ok_or(ScheduleError::InvalidInterval)?;
        return Ok(now + Duration::milliseconds(interval_ms as i64));
    }
    let timezone_name = timezone.as_deref().ok_or(ScheduleError::MissingTimezone)?;
    let timezone = timezone_name
        .parse::<Tz>()
        .map_err(|_| ScheduleError::InvalidTimezone(timezone_name.to_string()))?;
    let (hour, minute) = parse_time(time_of_day.as_deref().unwrap_or_default())?;
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
            if allowed.is_empty() {
                return Err(ScheduleError::MissingWeekdays);
            }
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
        .flat_map(|date| local_candidates(timezone, date, hour, minute, local_now))
        .filter(|candidate| *candidate > now)
        .min()
        .ok_or(ScheduleError::NoUpcomingOccurrence)
}

fn local_candidates(
    timezone: Tz,
    date: NaiveDate,
    hour: u32,
    minute: u32,
    local_now: DateTime<Tz>,
) -> Vec<DateTime<Utc>> {
    let Some(naive) = date.and_hms_opt(hour, minute, 0) else {
        return Vec::new();
    };
    match timezone.from_local_datetime(&naive) {
        LocalResult::Single(value) => vec![value.with_timezone(&Utc)],
        LocalResult::Ambiguous(earlier, later) => {
            vec![earlier.with_timezone(&Utc), later.with_timezone(&Utc)]
        }
        LocalResult::None => {
            // cron-parser maps a local time skipped by a DST gap using the
            // offset in effect before the transition, which shifts it forward
            // by the size of the gap instead of skipping the occurrence. The
            // wall-clock comparison still uses the requested time, so a gap
            // whose adjusted instant is later in UTC may already belong to
            // tomorrow once the local clock has advanced past it.
            if date == local_now.date_naive()
                && local_now.time()
                    >= chrono::NaiveTime::from_hms_opt(hour, minute, 0)
                        .expect("time components are validated before candidate resolution")
            {
                return Vec::new();
            }
            timezone
                .from_local_datetime(&(naive - Duration::days(1)))
                .earliest()
                .map(|previous| {
                    let offset = previous.with_timezone(&Utc).naive_utc() - previous.naive_local();
                    Utc.from_utc_datetime(&(naive + offset))
                })
                .into_iter()
                .collect()
        }
    }
}

fn parse_time(value: &str) -> Result<(u32, u32), ScheduleError> {
    let (hour, minute) = value
        .split_once(':')
        .ok_or(ScheduleError::InvalidTimeOfDay)?;
    let hour = hour.parse().map_err(|_| ScheduleError::InvalidTimeOfDay)?;
    let minute = minute
        .parse()
        .map_err(|_| ScheduleError::InvalidTimeOfDay)?;
    if hour >= 24 || minute >= 60 {
        return Err(ScheduleError::InvalidTimeOfDay);
    }
    Ok((hour, minute))
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

    #[test]
    fn invalid_timezone_is_reported_instead_of_falling_back() {
        let now = DateTime::parse_from_rfc3339("2026-11-02T00:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let mut schedule = source(TriggerScheduleKind::Daily);
        if let TriggerSource::Schedule { timezone, .. } = &mut schedule {
            *timezone = Some("Not/A_Timezone".to_string());
        }
        assert_eq!(
            next_schedule_time(&schedule, now),
            Err(ScheduleError::InvalidTimezone("Not/A_Timezone".to_string()))
        );
    }

    #[test]
    fn invalid_time_and_interval_values_are_not_silently_defaulted() {
        let now = DateTime::parse_from_rfc3339("2026-11-02T00:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let mut daily = source(TriggerScheduleKind::Daily);
        if let TriggerSource::Schedule { time_of_day, .. } = &mut daily {
            *time_of_day = Some("25:00".to_string());
        }
        assert_eq!(
            next_schedule_time(&daily, now),
            Err(ScheduleError::InvalidTimeOfDay)
        );

        let interval = TriggerSource::Schedule {
            schedule_kind: TriggerScheduleKind::Interval,
            interval_ms: Some(0),
            time_of_day: None,
            timezone: None,
            weekdays: None,
        };
        assert_eq!(
            next_schedule_time(&interval, now),
            Err(ScheduleError::InvalidInterval)
        );
    }

    #[test]
    fn dst_gaps_and_ambiguities_match_cron_parser() {
        let spring_now = DateTime::parse_from_rfc3339("2026-03-08T06:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let mut spring = source(TriggerScheduleKind::Daily);
        if let TriggerSource::Schedule {
            time_of_day,
            timezone,
            ..
        } = &mut spring
        {
            *time_of_day = Some("02:30".to_string());
            *timezone = Some("America/New_York".to_string());
        }
        assert_eq!(
            next_schedule_time(&spring, spring_now)
                .expect("spring schedule")
                .to_rfc3339(),
            "2026-03-08T07:30:00+00:00"
        );
        let after_gap = DateTime::parse_from_rfc3339("2026-03-08T07:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        assert_eq!(
            next_schedule_time(&spring, after_gap)
                .expect("next spring schedule")
                .to_rfc3339(),
            "2026-03-09T06:30:00+00:00"
        );

        let fall_now = DateTime::parse_from_rfc3339("2026-11-01T05:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let second_fall_now = DateTime::parse_from_rfc3339("2026-11-01T06:00:00Z")
            .expect("now")
            .with_timezone(&Utc);
        let mut fall = source(TriggerScheduleKind::Daily);
        if let TriggerSource::Schedule {
            time_of_day,
            timezone,
            ..
        } = &mut fall
        {
            *time_of_day = Some("01:30".to_string());
            *timezone = Some("America/New_York".to_string());
        }
        assert_eq!(
            next_schedule_time(&fall, fall_now)
                .expect("first fall occurrence")
                .to_rfc3339(),
            "2026-11-01T05:30:00+00:00"
        );
        assert_eq!(
            next_schedule_time(&fall, second_fall_now)
                .expect("second fall occurrence")
                .to_rfc3339(),
            "2026-11-01T06:30:00+00:00"
        );
    }
}
