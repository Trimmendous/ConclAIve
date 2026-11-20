//! Snapshot of the machine's spare capacity, read when the chair convenes.
//!
//! The frontend weighs this against how many CLI processes the chosen council
//! will run at once. Only raw numbers live here; the judgement of what counts
//! as too much is in `dist/js/resources.js`, where it can be unit-tested.

use serde::Serialize;
use sysinfo::System;

const MIB: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct SystemResources {
    total_memory_mb: u64,
    /// Memory the OS could hand out without swapping: free plus reclaimable.
    available_memory_mb: u64,
    logical_cpus: usize,
    /// One-minute load average; 0 where the platform has none (Windows).
    load_average: f64,
}

#[tauri::command]
pub fn system_resources() -> Result<SystemResources, String> {
    let mut sys = System::new().map_err(|e| format!("cannot read system resources: {e}"))?;
    sys.refresh_memory();
    Ok(SystemResources {
        total_memory_mb: sys.total_memory() / MIB,
        available_memory_mb: sys.available_memory() / MIB,
        logical_cpus: std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(1),
        load_average: System::load_average().map(|l| l.one).unwrap_or(0.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_plausible_numbers() {
        let r = system_resources().expect("resources readable");
        eprintln!("resources: {} MB total, {} MB available, {} cpus, load {:.2}", r.total_memory_mb, r.available_memory_mb, r.logical_cpus, r.load_average);
        assert!(r.total_memory_mb > 0);
        assert!(r.available_memory_mb <= r.total_memory_mb);
        assert!(r.logical_cpus >= 1);
        assert!(r.load_average >= 0.0);
    }
}
