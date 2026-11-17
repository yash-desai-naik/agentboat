//! Whether a registered session's process is still running.

#[cfg(windows)]
pub fn alive(pid: u32, proc_start: Option<&str>) -> bool {
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    const STILL_ACTIVE: u32 = 259;
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let running = GetExitCodeProcess(h, &mut code).is_ok() && code == STILL_ACTIVE;
        let mut same = true;
        if running && let Some(want) = proc_start.and_then(|s| s.parse::<u64>().ok()) {
            let (mut c, mut e, mut k, mut u) = (
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
                FILETIME::default(),
            );
            if GetProcessTimes(h, &mut c, &mut e, &mut k, &mut u).is_ok() {
                let created = ((c.dwHighDateTime as u64) << 32) | c.dwLowDateTime as u64;
                // Within a second: the recorded value may be rounded. A different value means
                // the pid was reused by another process.
                same = created.abs_diff(want) < 10_000_000;
            }
        }
        let _ = CloseHandle(h);
        running && same
    }
}

#[cfg(not(windows))]
pub fn alive(pid: u32, _proc_start: Option<&str>) -> bool {
    // Signal 0: checks the pid exists without signalling it.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}
