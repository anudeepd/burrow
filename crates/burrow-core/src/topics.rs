//! Topic registry — the extension point for the SSE hub (contract §6, a later slice).
//!
//! A *topic* is an API resource path without the `/api/` prefix, including its canonical query
//! (`yarn/apps?states=RUNNING`). The hub will poll a topic through [`crate::api::dispatch`] — i.e. through
//! the very same route table, cache and single-flight machinery as browser requests — and emit an
//! `invalidate` event when the body ETag changes. This module only holds the per-class poll intervals and
//! the "hub enabled" flag that `/api/meta` reports under `features.events`; it performs no I/O.

use std::time::Duration;

use parking_lot::RwLock;

#[derive(Debug, Clone)]
pub struct TopicClass {
    /// Matches topics starting with this prefix (longest prefix wins).
    pub prefix: &'static str,
    /// How often to poll while at least one subscriber exists.
    pub interval: Duration,
}

#[derive(Default)]
pub struct TopicRegistry {
    classes: RwLock<Vec<TopicClass>>,
    enabled: RwLock<bool>,
}

impl TopicRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, class: TopicClass) {
        self.classes.write().push(class);
    }

    /// Poll interval for `topic`, or `None` if no class matches.
    pub fn interval_for(&self, topic: &str) -> Option<Duration> {
        self.classes
            .read()
            .iter()
            .filter(|c| topic.starts_with(c.prefix))
            .max_by_key(|c| c.prefix.len())
            .map(|c| c.interval)
    }

    /// The hub flips this when it starts serving `/api/events`.
    pub fn set_enabled(&self, on: bool) {
        *self.enabled.write() = on;
    }

    pub fn is_enabled(&self) -> bool {
        *self.enabled.read()
    }

    /// Poll intervals per topic class. These are **overrides** for the interval the hub would otherwise derive from
    /// the route table's TTL ([`crate::routes::topic_interval`]) — use them to poll a class faster or slower than its
    /// cache TTL. A topic no class names is still pollable when the route table serves it. Longest prefix wins.
    pub fn register_defaults(&self) {
        for (prefix, secs) in [
            ("yarn/metrics", 1),
            ("yarn/scheduler/activities", 1),
            ("yarn/apps", 2),
            ("yarn/nodes", 3),
            ("yarn/scheduler", 3),
            ("rm/jmx", 1),
            ("rm/conf", 60),
            ("spark/", 2),
        ] {
            self.register(TopicClass {
                prefix,
                interval: Duration::from_secs(secs),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_prefix_wins() {
        let r = TopicRegistry::new();
        assert!(!r.is_enabled());
        r.register(TopicClass {
            prefix: "yarn/",
            interval: Duration::from_secs(5),
        });
        r.register(TopicClass {
            prefix: "yarn/metrics",
            interval: Duration::from_secs(1),
        });
        assert_eq!(r.interval_for("yarn/metrics"), Some(Duration::from_secs(1)));
        assert_eq!(r.interval_for("yarn/apps"), Some(Duration::from_secs(5)));
        assert_eq!(r.interval_for("spark/x"), None);
        r.set_enabled(true);
        assert!(r.is_enabled());
    }
}
