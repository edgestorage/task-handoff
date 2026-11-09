//! Use maintained CoreGraphics bindings for coordinate-bearing mouse events.
//! Enigo0.6.1 posts moves asynchronously, then button() reads NSEvent's old
//! position (actual fixture requested x500, received x100). Its position read
//! also mixes Retina pixels with points. Avoid delays and OS position readback:
//! every input event carries its authoritative actuator coordinates directly.
use core_graphics::{
    event::{CGEvent, CGEventTapLocation, CGEventType, CGMouseButton, EventField, ScrollEventUnit},
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::CGPoint,
};
use std::{collections::HashSet, time::Instant};
type Click = (Instant, (i32, i32), i64);
pub struct Mouse {
    source: CGEventSource,
    clicks: [Option<Click>; 5],
}
impl Mouse {
    pub fn new() -> anyhow::Result<Self> {
        Ok(Self {
            source: CGEventSource::new(CGEventSourceStateID::HIDSystemState)
                .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))?,
            clicks: [None; 5],
        })
    }
    fn post(
        &self,
        point: (i32, i32),
        kind: CGEventType,
        code: u8,
        clicks: i64,
    ) -> anyhow::Result<()> {
        let button = match code {
            0 => CGMouseButton::Left,
            2 => CGMouseButton::Right,
            _ => CGMouseButton::Center,
        };
        let event = CGEvent::new_mouse_event(
            self.source.clone(),
            kind,
            CGPoint::new(point.0 as f64, point.1 as f64),
            button,
        )
        .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))?;
        let number = match code {
            0 => 0,
            1 => 2,
            2 => 1,
            _ => code as i64,
        };
        event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, number);
        event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, clicks);
        event.post(CGEventTapLocation::HID);
        Ok(())
    }
    pub fn pointer(&self, point: (i32, i32), pressed: &HashSet<u8>) -> anyhow::Result<()> {
        let (kind, code) = if pressed.contains(&0) {
            (CGEventType::LeftMouseDragged, 0)
        } else if pressed.contains(&2) {
            (CGEventType::RightMouseDragged, 2)
        } else if let Some(code) = pressed.iter().min() {
            (CGEventType::OtherMouseDragged, *code)
        } else {
            (CGEventType::MouseMoved, 0)
        };
        self.post(point, kind, code, 0)
    }
    pub fn button(&mut self, point: (i32, i32), code: u8, down: bool) -> anyhow::Result<()> {
        anyhow::ensure!(code <= 4, "REMOTE_DESKTOP_UNSUPPORTED_BUTTON");
        let now = Instant::now();
        let previous = self.clicks[code as usize];
        let count = if down {
            let count = previous
                .filter(|(at, p, _)| {
                    now.duration_since(*at).as_secs_f64()
                        <= objc2_app_kit::NSEvent::doubleClickInterval()
                        && (p.0 as i64 - point.0 as i64).abs() <= 4
                        && (p.1 as i64 - point.1 as i64).abs() <= 4
                })
                .map_or(1, |(_, _, n)| n.saturating_add(1));
            self.clicks[code as usize] = Some((now, point, count));
            count
        } else {
            previous.map_or(1, |(_, _, n)| n)
        };
        let kind = match (code, down) {
            (0, true) => CGEventType::LeftMouseDown,
            (0, false) => CGEventType::LeftMouseUp,
            (2, true) => CGEventType::RightMouseDown,
            (2, false) => CGEventType::RightMouseUp,
            (_, true) => CGEventType::OtherMouseDown,
            (_, false) => CGEventType::OtherMouseUp,
        };
        self.post(point, kind, code, count)
    }
    pub fn wheel(&self, point: (i32, i32), dx: f64, dy: f64) -> anyhow::Result<()> {
        let event = CGEvent::new_scroll_event(
            self.source.clone(),
            ScrollEventUnit::LINE,
            2,
            -(dy / 40.0).round() as i32,
            -(dx / 40.0).round() as i32,
            0,
        )
        .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_FAILED"))?;
        event.set_location(CGPoint::new(point.0 as f64, point.1 as f64));
        event.post(CGEventTapLocation::HID);
        Ok(())
    }
    pub fn release(&mut self, code: u8) -> anyhow::Result<()> {
        // Cleanup bypasses display geometry validation, including after a change.
        let event = CGEvent::new(self.source.clone())
            .map_err(|_| anyhow::anyhow!("REMOTE_DESKTOP_INPUT_RELEASE_FAILED"))?;
        let point = event.location();
        self.button(
            (point.x.round() as i32, point.y.round() as i32),
            code,
            false,
        )
    }
}
