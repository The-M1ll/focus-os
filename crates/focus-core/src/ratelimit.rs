use crate::error::{Error, Result};
use std::collections::HashMap;
use std::sync::Mutex;

/// Fixed-window counter keyed by an arbitrary string.
#[derive(Default)]
pub struct RateLimiter {
    map: Mutex<HashMap<String, (i64, u32)>>,
}

impl RateLimiter {
    pub fn check(&self, key: &str, limit: u32, window_ms: i64, now: i64) -> Result<()> {
        let mut m = self.map.lock().unwrap_or_else(|p| p.into_inner());
        if m.len() > 20_000 {
            m.retain(|_, (start, _)| now - *start < window_ms);
        }
        let e = m.entry(key.to_string()).or_insert((now, 0));
        if now - e.0 >= window_ms {
            *e = (now, 0);
        }
        if e.1 >= limit {
            let retry = ((e.0 + window_ms - now).max(0) / 1000 + 1) as u64;
            return Err(Error::RateLimited(retry));
        }
        e.1 += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn limits_then_resets() {
        let r = RateLimiter::default();
        for _ in 0..3 {
            r.check("k", 3, 1000, 0).unwrap();
        }
        assert!(matches!(
            r.check("k", 3, 1000, 10),
            Err(Error::RateLimited(_))
        ));
        r.check("other", 3, 1000, 10).unwrap();
        r.check("k", 3, 1000, 1001).unwrap();
    }
}
