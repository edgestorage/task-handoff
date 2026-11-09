//! One latest native sample, with terminal failures latched until a new stream
//! gets a fresh mailbox. Clones belong to one stream generation only.
use crate::error::BackendError;
use std::sync::{Arc, Mutex};

struct State<T> {
    frame: Option<T>,
    error: Option<BackendError>,
}

pub(super) struct FrameMailbox<T>(Arc<Mutex<State<T>>>);
impl<T> Default for FrameMailbox<T> {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(State {
            frame: None,
            error: None,
        })))
    }
}
impl<T> Clone for FrameMailbox<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<T> FrameMailbox<T> {
    pub fn publish(&self, frame: T) {
        let mut state = self.0.lock().unwrap();
        if state.error.is_none() {
            state.frame = Some(frame);
        }
    }
    pub fn fail(&self, error: BackendError) {
        let mut state = self.0.lock().unwrap();
        state.frame = None;
        state.error.get_or_insert(error);
    }
    pub fn snapshot(&self) -> Result<Option<T>, BackendError>
    where
        T: Clone,
    {
        let state = self.0.lock().unwrap();
        match state.error {
            Some(error) => Err(error),
            None => Ok(state.frame.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn idle_reuses_one_latest_sample_but_terminal_failure_releases_it() {
        let mailbox = FrameMailbox::default();
        let first = Arc::new(1);
        let weak = Arc::downgrade(&first);
        mailbox.publish(first);
        assert_eq!(mailbox.snapshot().unwrap().as_deref(), Some(&1));
        assert_eq!(mailbox.snapshot().unwrap().as_deref(), Some(&1));
        mailbox.publish(Arc::new(2));
        assert!(weak.upgrade().is_none());
        mailbox.fail(BackendError::GeometryChanged);
        mailbox.publish(Arc::new(3));
        mailbox.fail(BackendError::CaptureFailed);
        assert_eq!(
            mailbox.snapshot().unwrap_err(),
            BackendError::GeometryChanged
        );
    }
    #[test]
    fn old_callbacks_cannot_mutate_resumed_stream() {
        let mut mailbox = FrameMailbox::default();
        let obsolete_callback = mailbox.clone();
        mailbox.publish(1);
        let previous_stream = std::mem::take(&mut mailbox);
        mailbox.publish(2);
        obsolete_callback.publish(3);
        obsolete_callback.fail(BackendError::CaptureFailed);
        assert_eq!(mailbox.snapshot().unwrap(), Some(2));
        assert_eq!(
            previous_stream.snapshot().unwrap_err(),
            BackendError::CaptureFailed
        );
    }
}
