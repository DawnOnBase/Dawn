//! Idle detection . Decides whether the machine is truly idle
//! and safe to run jobs on, from userspace signals only (no kernel ext / root).
//! Instant yield: any sign of user return flips the decision to Active.
//!
//! `Signals` are gathered by platform code (screen lock, input inactivity,
//! battery, thermal). The decision policy here is pure and fully tested; the
//! platform probes are a thin follow-up per OS.

/// User-configurable guard rails .
#[derive(Debug, Clone)]
pub struct IdleConfig {
    /// Required input inactivity before the machine counts as idle.
    pub idle_threshold_secs: u64,
    /// Refuse to run on battery below this charge percentage.
    pub battery_floor_pct: u8,
    /// Whether to run at all while on battery.
    pub allow_on_battery: bool,
    /// Refuse to run above this thermal headroom usage (0..=100); 100 disables.
    pub thermal_limit_pct: u8,
}

impl Default for IdleConfig {
    fn default() -> Self {
        Self {
            idle_threshold_secs: 120,
            battery_floor_pct: 50,
            allow_on_battery: false,
            thermal_limit_pct: 90,
        }
    }
}

/// Live signals sampled from the OS.
#[derive(Debug, Clone)]
pub struct Signals {
    pub input_idle_secs: u64,
    pub screen_locked: bool,
    pub on_battery: bool,
    pub battery_pct: u8,
    pub thermal_pct: u8,
    /// Within a user-defined blackout schedule.
    pub blackout: bool,
    /// One-click pause engaged by the user.
    pub paused: bool,
}

/// The detector's verdict. `Active` carries the reason it yielded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Idle,
    Active(&'static str),
}

/// Evaluate the idle policy. Checks are ordered so the most user-respecting
/// reasons win (pause/blackout/return) before opportunistic idle.
pub fn evaluate(cfg: &IdleConfig, s: &Signals) -> Decision {
    if s.paused {
        return Decision::Active("paused");
    }
    if s.blackout {
        return Decision::Active("blackout schedule");
    }
    if s.on_battery && !cfg.allow_on_battery {
        return Decision::Active("on battery");
    }
    if s.on_battery && s.battery_pct < cfg.battery_floor_pct {
        return Decision::Active("battery below floor");
    }
    if cfg.thermal_limit_pct < 100 && s.thermal_pct >= cfg.thermal_limit_pct {
        return Decision::Active("thermal limit");
    }
    let idle_enough = s.screen_locked || s.input_idle_secs >= cfg.idle_threshold_secs;
    if !idle_enough {
        return Decision::Active("user active");
    }
    Decision::Idle
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idle_signals() -> Signals {
        Signals {
            input_idle_secs: 300,
            screen_locked: false,
            on_battery: false,
            battery_pct: 100,
            thermal_pct: 40,
            blackout: false,
            paused: false,
        }
    }

    #[test]
    fn idle_when_inactive_and_plugged_in() {
        assert_eq!(
            evaluate(&IdleConfig::default(), &idle_signals()),
            Decision::Idle
        );
    }

    #[test]
    fn screen_lock_counts_as_idle_even_with_recent_input() {
        let mut s = idle_signals();
        s.input_idle_secs = 0;
        s.screen_locked = true;
        assert_eq!(evaluate(&IdleConfig::default(), &s), Decision::Idle);
    }

    #[test]
    fn instant_yield_on_user_return() {
        let mut s = idle_signals();
        s.input_idle_secs = 1; // user just moved the mouse
        s.screen_locked = false;
        assert_eq!(
            evaluate(&IdleConfig::default(), &s),
            Decision::Active("user active")
        );
    }

    #[test]
    fn respects_pause_blackout_battery_thermal() {
        let cfg = IdleConfig::default();

        let mut paused = idle_signals();
        paused.paused = true;
        assert_eq!(evaluate(&cfg, &paused), Decision::Active("paused"));

        let mut blackout = idle_signals();
        blackout.blackout = true;
        assert_eq!(
            evaluate(&cfg, &blackout),
            Decision::Active("blackout schedule")
        );

        let mut battery = idle_signals();
        battery.on_battery = true;
        assert_eq!(evaluate(&cfg, &battery), Decision::Active("on battery"));

        let mut low = idle_signals();
        low.on_battery = true;
        low.battery_pct = 20;
        let allow_batt = IdleConfig {
            allow_on_battery: true,
            ..IdleConfig::default()
        };
        assert_eq!(
            evaluate(&allow_batt, &low),
            Decision::Active("battery below floor")
        );

        let mut hot = idle_signals();
        hot.thermal_pct = 95;
        assert_eq!(evaluate(&cfg, &hot), Decision::Active("thermal limit"));
    }
}
