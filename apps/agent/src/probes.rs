//! Per-OS idle/power probes .
//!
//! [`crate::idle`] is the pure policy (given [`Signals`], decide run vs. yield).
//! This module is the OS sampling layer that fills those `Signals` from the
//! live machine, behind `cfg(target_os)`:
//!
//!   - **Windows**: `GetLastInputInfo` (input idle) + `GetSystemPowerStatus`
//!     (AC/battery), via Win32 directly.
//!   - **Linux**: battery + thermal from `/sys` (pure std). Input-idle needs
//!     X11/Wayland and is a documented follow-up; until then it fails SAFE.
//!   - **macOS**: input-idle via Core Graphics `CGEventSourceSecondsSinceLastEventType`
//!     (the canonical idle measure) + AC/battery from `pmset -g batt`. Screen-lock
//!     and thermal are follow-ups; they fail SAFE.
//!   - **other**: not yet probed — fails SAFE.
//!
//! Fail-safe means: when a signal is unknown we err toward NOT borrowing the
//! machine — an unknown idle time reports the user as active, so the agent
//! never runs on a machine it can't confirm is idle. A triggered/headless run
//! bypasses probing via `DAWN_FORCE_RUN` (see `main.rs`).

use crate::idle::Signals;
use std::time::Duration;

/// User controls that are not derived from the OS (set by config / scheduler).
#[derive(Debug, Clone, Default)]
pub struct ProbeConfig {
    pub paused: bool,
    pub blackout: bool,
}

/// Raw OS-derived signals; `None` means "couldn't determine".
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OsSignals {
    pub input_idle: Option<Duration>,
    pub screen_locked: Option<bool>,
    pub on_battery: Option<bool>,
    pub battery_pct: Option<u8>,
    pub thermal_pct: Option<u8>,
}

/// Sample the OS and fold in user controls, applying fail-safe fallbacks.
pub fn sample(cfg: &ProbeConfig) -> Signals {
    compose(os_probe(), cfg)
}

/// Combine raw OS readings with config into the policy's [`Signals`]. Pure, so
/// the fail-safe behaviour is unit-tested on every platform.
pub fn compose(os: OsSignals, cfg: &ProbeConfig) -> Signals {
    Signals {
        // Unknown idle -> 0s -> "user active": never run when we can't confirm idle.
        input_idle_secs: os.input_idle.map(|d| d.as_secs()).unwrap_or(0),
        screen_locked: os.screen_locked.unwrap_or(false),
        // Unknown power -> assume plugged-in desktop (the idle gate dominates safety).
        on_battery: os.on_battery.unwrap_or(false),
        battery_pct: os.battery_pct.unwrap_or(100),
        // Unknown thermal -> no pressure.
        thermal_pct: os.thermal_pct.unwrap_or(0),
        blackout: cfg.blackout,
        paused: cfg.paused,
    }
}

// ── Pure parsing helpers (compiled everywhere so they're tested on any host) ──

/// Parse a Linux `/sys` battery `capacity` file (an integer percent).
pub fn parse_capacity(s: &str) -> Option<u8> {
    let v: u32 = s.trim().parse().ok()?;
    Some(v.min(100) as u8)
}

/// Interpret a power_supply `online` value (`"1"` = AC present → not on battery).
pub fn interpret_ac_online(s: &str) -> Option<bool> {
    match s.trim() {
        "1" => Some(false),
        "0" => Some(true),
        _ => None,
    }
}

/// A battery `status` of "Discharging" means the machine is on battery.
pub fn is_discharging(s: &str) -> bool {
    s.trim().eq_ignore_ascii_case("Discharging")
}

/// Map a thermal-zone reading in millidegrees C to a 0–100% load of a 100°C
/// ceiling (e.g. 80°C → 80%). Clamped.
pub fn milli_to_pct(milli: i64) -> u8 {
    (milli / 1000).clamp(0, 100) as u8
}

/// Parse `pmset -g batt` output → `(on_battery, battery_pct)`. macOS reports the
/// current power source as `'Battery Power'` or `'AC Power'`, and the charge as an
/// `NN%` token. Either field is `None` if absent (fails safe via `compose`).
pub fn parse_pmset_batt(s: &str) -> (Option<bool>, Option<u8>) {
    let on_battery = if s.contains("'Battery Power'") {
        Some(true)
    } else if s.contains("'AC Power'") {
        Some(false)
    } else {
        None
    };
    (on_battery, extract_pct(s))
}

/// Read the percentage immediately preceding the first `%` in `s` (e.g. `73%;` → 73).
fn extract_pct(s: &str) -> Option<u8> {
    let idx = s.find('%')?;
    let bytes = s.as_bytes();
    let mut start = idx;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if start == idx {
        return None;
    }
    s[start..idx].parse::<u8>().ok().map(|v| v.min(100))
}

// ── Windows ──────────────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
fn os_probe() -> OsSignals {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    // Input idle: now - last input event (both GetTickCount-based, ms).
    let input_idle = unsafe {
        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        if GetLastInputInfo(&mut info) != 0 {
            let elapsed = GetTickCount().wrapping_sub(info.dwTime);
            Some(Duration::from_millis(elapsed as u64))
        } else {
            None
        }
    };

    // Power: ACLineStatus 0=offline(battery) 1=online 255=unknown; BatteryLifePercent 0..100 or 255.
    let (on_battery, battery_pct) = unsafe {
        let mut sps: SYSTEM_POWER_STATUS = std::mem::zeroed();
        if GetSystemPowerStatus(&mut sps) != 0 {
            let on_battery = match sps.ACLineStatus {
                0 => Some(true),
                1 => Some(false),
                _ => None,
            };
            let battery_pct = if sps.BatteryLifePercent <= 100 {
                Some(sps.BatteryLifePercent)
            } else {
                None
            };
            (on_battery, battery_pct)
        } else {
            (None, None)
        }
    };

    OsSignals {
        input_idle,
        screen_locked: None, // session-lock detection is a follow-up
        on_battery,
        battery_pct,
        thermal_pct: None, // Windows thermal needs WMI; follow-up
    }
}

// ── Linux ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn os_probe() -> OsSignals {
    use std::path::Path;
    OsSignals {
        // Input idle needs X11 (XScreenSaver) or Wayland idle-notify — follow-up.
        input_idle: None,
        screen_locked: None,
        on_battery: linux::on_battery(Path::new("/sys/class/power_supply")),
        battery_pct: linux::battery_pct(Path::new("/sys/class/power_supply")),
        thermal_pct: linux::thermal_pct(Path::new("/sys/class/thermal")),
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::{interpret_ac_online, is_discharging, milli_to_pct, parse_capacity};
    use std::fs;
    use std::path::Path;

    /// First `BAT*/capacity` under the power-supply root.
    pub fn battery_pct(root: &Path) -> Option<u8> {
        for entry in fs::read_dir(root).ok()?.flatten() {
            if entry.file_name().to_string_lossy().starts_with("BAT") {
                if let Ok(s) = fs::read_to_string(entry.path().join("capacity")) {
                    if let Some(pct) = parse_capacity(&s) {
                        return Some(pct);
                    }
                }
            }
        }
        None
    }

    /// Prefer an AC adapter's `online`; fall back to a battery's `status`.
    pub fn on_battery(root: &Path) -> Option<bool> {
        let mut from_ac = None;
        let mut from_bat = None;
        for entry in fs::read_dir(root).ok()?.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with("AC") || name.starts_with("ADP") {
                if let Ok(s) = fs::read_to_string(entry.path().join("online")) {
                    from_ac = interpret_ac_online(&s);
                }
            } else if name.starts_with("BAT") {
                if let Ok(s) = fs::read_to_string(entry.path().join("status")) {
                    from_bat = Some(is_discharging(&s));
                }
            }
        }
        from_ac.or(from_bat)
    }

    /// Hottest thermal zone, mapped to a percentage of a 100°C ceiling.
    pub fn thermal_pct(root: &Path) -> Option<u8> {
        let mut max_milli: Option<i64> = None;
        for entry in fs::read_dir(root).ok()?.flatten() {
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("thermal_zone")
            {
                if let Ok(s) = fs::read_to_string(entry.path().join("temp")) {
                    if let Ok(m) = s.trim().parse::<i64>() {
                        max_milli = Some(max_milli.map_or(m, |x| x.max(m)));
                    }
                }
            }
        }
        max_milli.map(milli_to_pct)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::atomic::{AtomicU32, Ordering};

        // Build an isolated fake /sys tree under the temp dir.
        fn fixture() -> std::path::PathBuf {
            static N: AtomicU32 = AtomicU32::new(0);
            let dir = std::env::temp_dir().join(format!(
                "dawn-probe-{}-{}",
                std::process::id(),
                N.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn write(path: &Path, name: &str, file: &str, contents: &str) {
            let d = path.join(name);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join(file), contents).unwrap();
        }

        #[test]
        fn reads_battery_capacity() {
            let root = fixture();
            write(&root, "BAT0", "capacity", "73\n");
            assert_eq!(battery_pct(&root), Some(73));
        }

        #[test]
        fn missing_battery_is_none() {
            let root = fixture();
            write(&root, "AC", "online", "1\n");
            assert_eq!(battery_pct(&root), None);
        }

        #[test]
        fn ac_online_means_not_on_battery() {
            let root = fixture();
            write(&root, "AC", "online", "1\n");
            write(&root, "BAT0", "status", "Charging\n");
            assert_eq!(on_battery(&root), Some(false));
        }

        #[test]
        fn ac_offline_means_on_battery() {
            let root = fixture();
            write(&root, "AC", "online", "0\n");
            assert_eq!(on_battery(&root), Some(true));
        }

        #[test]
        fn battery_status_fallback_when_no_ac() {
            let root = fixture();
            write(&root, "BAT0", "status", "Discharging\n");
            assert_eq!(on_battery(&root), Some(true));
        }

        #[test]
        fn thermal_takes_the_hottest_zone() {
            let root = fixture();
            write(&root, "thermal_zone0", "temp", "42000\n");
            write(&root, "thermal_zone1", "temp", "67000\n");
            assert_eq!(thermal_pct(&root), Some(67));
        }

        #[test]
        fn thermal_absent_is_none() {
            let root = fixture();
            assert_eq!(thermal_pct(&root), None);
        }
    }
}

// ── macOS ────────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
fn os_probe() -> OsSignals {
    let (on_battery, battery_pct) = macos::power();
    OsSignals {
        input_idle: macos::input_idle(),
        screen_locked: None, // CGSSessionScreenIsLocked — follow-up
        on_battery,
        battery_pct,
        thermal_pct: None, // NSProcessInfo.thermalState (objc) — follow-up
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::parse_pmset_batt;
    use std::time::Duration;

    // Core Graphics: seconds since the last HID input event — the canonical macOS
    // user-idle measure (mirrors what the screensaver uses).
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state_id: i32, event_type: u32) -> f64;
    }
    // CGEventSourceStateID.kCGEventSourceStateHIDSystemState = 1.
    const HID_SYSTEM_STATE: i32 = 1;
    // kCGAnyInputEventType = ~0 (any keyboard/mouse/tablet event).
    const ANY_INPUT_EVENT: u32 = u32::MAX;

    /// Seconds since the last keyboard/mouse event, or `None` if the API returns a
    /// non-finite/negative value.
    pub fn input_idle() -> Option<Duration> {
        let secs =
            unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT_EVENT) };
        (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs))
    }

    /// AC/battery + charge from `pmset -g batt`. Desktops with no battery return
    /// `(None, None)`, which `compose` treats as "plugged in" (the idle gate dominates).
    pub fn power() -> (Option<bool>, Option<u8>) {
        match std::process::Command::new("pmset")
            .args(["-g", "batt"])
            .output()
        {
            Ok(o) if o.status.success() => parse_pmset_batt(&String::from_utf8_lossy(&o.stdout)),
            _ => (None, None),
        }
    }
}

// ── Other platforms ──────────────────────────────────────────────────────────

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn os_probe() -> OsSignals {
    // Not yet probed; fails SAFE via compose() fallbacks.
    OsSignals::default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::idle::{evaluate, Decision, IdleConfig};

    #[test]
    fn parse_capacity_clamps_and_parses() {
        assert_eq!(parse_capacity("57\n"), Some(57));
        assert_eq!(parse_capacity("0"), Some(0));
        assert_eq!(parse_capacity("150"), Some(100)); // clamp
        assert_eq!(parse_capacity("nope"), None);
    }

    #[test]
    fn ac_online_interpretation() {
        assert_eq!(interpret_ac_online("1\n"), Some(false)); // plugged in
        assert_eq!(interpret_ac_online("0"), Some(true)); // on battery
        assert_eq!(interpret_ac_online("?"), None);
    }

    #[test]
    fn discharging_means_on_battery() {
        assert!(is_discharging("Discharging\n"));
        assert!(!is_discharging("Charging"));
        assert!(!is_discharging("Full"));
    }

    #[test]
    fn thermal_mapping() {
        assert_eq!(milli_to_pct(45_000), 45); // 45°C
        assert_eq!(milli_to_pct(120_000), 100); // clamp
        assert_eq!(milli_to_pct(-5_000), 0); // clamp negative
    }

    #[test]
    fn pmset_on_battery() {
        let out = "Now drawing from 'Battery Power'\n \
            -InternalBattery-0 (id=12345)\t73%; discharging; 3:21 remaining present: true";
        assert_eq!(parse_pmset_batt(out), (Some(true), Some(73)));
    }

    #[test]
    fn pmset_on_ac_charged() {
        let out = "Now drawing from 'AC Power'\n \
            -InternalBattery-0 (id=12345)\t100%; charged; 0:00 remaining present: true";
        assert_eq!(parse_pmset_batt(out), (Some(false), Some(100)));
    }

    #[test]
    fn pmset_desktop_no_battery() {
        // Mac with no internal battery: no source line, no percentage.
        assert_eq!(
            parse_pmset_batt("No adapter information available"),
            (None, None)
        );
    }

    // Runs only on a real Mac (this dev box + macOS CI): the FFI idle probe must
    // return a value, proving CoreGraphics links and the agent can gate on idle.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_input_idle_is_readable() {
        assert!(
            super::macos::input_idle().is_some(),
            "CGEventSource idle probe should return a value on macOS"
        );
        // power() must not panic; value depends on the host (laptop vs desktop).
        let _ = super::macos::power();
    }

    #[test]
    fn compose_unknown_idle_reads_as_active() {
        // The key safety property: no OS reading => do not run.
        let s = compose(OsSignals::default(), &ProbeConfig::default());
        assert_eq!(s.input_idle_secs, 0);
        assert_eq!(
            evaluate(&IdleConfig::default(), &s),
            Decision::Active("user active")
        );
    }

    #[test]
    fn compose_idle_machine_runs() {
        let os = OsSignals {
            input_idle: Some(Duration::from_secs(600)),
            screen_locked: Some(false),
            on_battery: Some(false),
            battery_pct: Some(100),
            thermal_pct: Some(30),
        };
        let s = compose(os, &ProbeConfig::default());
        assert_eq!(s.input_idle_secs, 600);
        assert_eq!(evaluate(&IdleConfig::default(), &s), Decision::Idle);
    }

    #[test]
    fn compose_passes_through_user_controls() {
        let idle_os = OsSignals {
            input_idle: Some(Duration::from_secs(600)),
            ..Default::default()
        };
        let paused = compose(
            idle_os.clone(),
            &ProbeConfig {
                paused: true,
                blackout: false,
            },
        );
        assert_eq!(
            evaluate(&IdleConfig::default(), &paused),
            Decision::Active("paused")
        );

        let blackout = compose(
            idle_os,
            &ProbeConfig {
                paused: false,
                blackout: true,
            },
        );
        assert_eq!(
            evaluate(&IdleConfig::default(), &blackout),
            Decision::Active("blackout schedule")
        );
    }

    #[test]
    fn compose_unknown_power_assumes_plugged_in() {
        let os = OsSignals {
            input_idle: Some(Duration::from_secs(600)),
            on_battery: None,
            battery_pct: None,
            ..Default::default()
        };
        let s = compose(os, &ProbeConfig::default());
        assert!(!s.on_battery);
        assert_eq!(s.battery_pct, 100);
    }
}
