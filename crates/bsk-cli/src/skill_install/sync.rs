//! Keep installed `SKILL.md` files in sync with the `bsk` binary's
//! bundled copy. Best-effort: I/O errors are recorded, never thrown.

use std::path::Path;

use anyhow::{Context, Result};

use super::{
    DEFAULT_SKILL_MD, SOURCE_BUNDLED, SOURCE_MARKER_FILE,
    harness::HarnessId,
    storage::{PendingWrite, SkillLock},
};

/// Per-harness outcome of a sync pass.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncReport {
    /// Harnesses whose on-disk `SKILL.md` differed and was rewritten.
    pub updated: Vec<HarnessId>,
    /// Managed harnesses whose on-disk `SKILL.md` already matched the bundled
    /// content; no write happened, mtime preserved.
    pub up_to_date: Vec<HarnessId>,
    /// Custom or historical untracked installations that must not be
    /// overwritten by automatic bundled-skill synchronization.
    pub protected: Vec<HarnessId>,
    /// Another install/sync holds the lock; retry on a later sync pass.
    pub busy: Vec<HarnessId>,
    /// Harnesses that have an installed `SKILL.md` but the sync attempt
    /// failed with an I/O error. The string is a human-readable detail.
    pub errors: Vec<(HarnessId, String)>,
}

/// Iterates `HarnessId::ALL`, syncing harnesses with an existing
/// `SKILL.md` and leaving the rest untouched.
pub fn sync_installed_skills(home: &Path) -> SyncReport {
    sync_with_source(home, DEFAULT_SKILL_MD)
}

/// Test seam: lets unit tests inject a synthetic "bundled" payload.
pub(crate) fn sync_with_source(home: &Path, source: &str) -> SyncReport {
    let mut report = SyncReport::default();
    for &harness in HarnessId::ALL {
        let dest = harness.skill_dest_dir_for_home(home).join("SKILL.md");
        match sync_one(&dest, source) {
            Ok(SyncOne::Missing) => continue,
            Ok(SyncOne::UpToDate) => report.up_to_date.push(harness),
            Ok(SyncOne::Updated) => report.updated.push(harness),
            Ok(SyncOne::Protected) => report.protected.push(harness),
            Ok(SyncOne::Busy) => report.busy.push(harness),
            Err(err) => report.errors.push((harness, format!("{err:#}"))),
        }
    }
    report
}

enum SyncOne {
    Missing,
    UpToDate,
    Updated,
    Protected,
    Busy,
}

fn sync_one(dest: &Path, source: &str) -> Result<SyncOne> {
    // Do not create directories or locks for uninstalled harnesses.
    if !dest.is_file() {
        return Ok(SyncOne::Missing);
    }
    let dir = dest.parent().context("skill destination has no parent")?;
    let Some(_lock) =
        SkillLock::try_acquire(dir).with_context(|| format!("lock {}", dir.display()))?
    else {
        return Ok(SyncOne::Busy);
    };

    // Check ownership under the lock, even when the content is identical.
    let marker = dir.join(SOURCE_MARKER_FILE);
    match std::fs::read_to_string(&marker) {
        Ok(value) if value == SOURCE_BUNDLED => {}
        Ok(_) => return Ok(SyncOne::Protected),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(SyncOne::Protected),
        Err(err) => return Err(err).with_context(|| format!("read {}", marker.display())),
    }
    let on_disk = match std::fs::read_to_string(dest) {
        Ok(content) => content,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(SyncOne::Missing),
        Err(err) => return Err(err).with_context(|| format!("read {}", dest.display())),
    };
    if on_disk == source {
        return Ok(SyncOne::UpToDate);
    }
    PendingWrite::prepare(dest, source)?.commit()?;
    Ok(SyncOne::Updated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn mark_bundled(dest: &Path) {
        std::fs::write(
            dest.parent().unwrap().join(SOURCE_MARKER_FILE),
            SOURCE_BUNDLED,
        )
        .unwrap();
    }

    #[test]
    fn sync_skips_uninstalled_harness() {
        let tmp = TempDir::new().unwrap();
        let report = sync_with_source(tmp.path(), "anything");
        assert!(report.updated.is_empty());
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        // Defensive: sync must not silently create files in harnesses that
        // never had the skill installed. This guards Task 2's real impl.
        let dest = HarnessId::Cursor
            .skill_dest_dir_for_home(tmp.path())
            .join("SKILL.md");
        assert!(
            !dest.parent().unwrap().exists(),
            "sync should not create directories or locks for uninstalled harnesses"
        );
    }

    #[test]
    fn sync_updates_outdated_skill() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, b"old content").unwrap();
        mark_bundled(&dest);

        let report = sync_with_source(home, "fresh content");

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert!(report.up_to_date.is_empty());
        assert!(report.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh content");
        super::super::storage::test_support::assert_no_temporary_files(&dest_dir);
    }

    #[test]
    fn sync_skips_when_up_to_date() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        let dest_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&dest_dir).unwrap();
        let dest = dest_dir.join("SKILL.md");
        std::fs::write(&dest, "frozen content").unwrap();
        mark_bundled(&dest);
        let mtime_before = std::fs::metadata(&dest).unwrap().modified().unwrap();

        // Sleep enough that any rewrite would visibly change mtime on
        // platforms with coarse fs timestamps (HFS+ has 1 s granularity).
        std::thread::sleep(std::time::Duration::from_millis(1100));

        let report = sync_with_source(home, "frozen content");

        assert_eq!(report.up_to_date, vec![HarnessId::Cursor]);
        assert!(report.updated.is_empty());
        assert!(report.errors.is_empty());
        let mtime_after = std::fs::metadata(&dest).unwrap().modified().unwrap();
        assert_eq!(
            mtime_before, mtime_after,
            "up-to-date sync should not touch mtime"
        );
    }

    #[cfg(unix)]
    #[test]
    fn sync_continues_on_partial_error() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        // Cursor: writable, outdated → should be updated.
        let cursor_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&cursor_dir).unwrap();
        std::fs::write(cursor_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&cursor_dir.join("SKILL.md"));

        // Codex: a read-only directory prevents lock creation. The other
        // harness must still update, and the failure must not become Busy.
        let codex_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&codex_dir).unwrap();
        std::fs::write(codex_dir.join("SKILL.md"), "old").unwrap();
        mark_bundled(&codex_dir.join("SKILL.md"));
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o500); // r-x: blocks tmp creation in this dir
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        let report = sync_with_source(home, "fresh");

        // Restore perms so TempDir can clean up.
        let mut perms = std::fs::metadata(&codex_dir).unwrap().permissions();
        perms.set_mode(0o700);
        std::fs::set_permissions(&codex_dir, perms).unwrap();

        assert_eq!(report.updated, vec![HarnessId::Cursor]);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, HarnessId::Codex);
    }

    #[test]
    fn sync_preserves_custom_and_untracked_skills() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();

        let custom_dir = HarnessId::Cursor.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&custom_dir).unwrap();
        std::fs::write(custom_dir.join("SKILL.md"), "custom content").unwrap();
        std::fs::write(custom_dir.join(SOURCE_MARKER_FILE), "custom\n").unwrap();

        let untracked_dir = HarnessId::Codex.skill_dest_dir_for_home(home);
        std::fs::create_dir_all(&untracked_dir).unwrap();
        std::fs::write(untracked_dir.join("SKILL.md"), "historical content").unwrap();

        let report = sync_with_source(home, "new bundled content");

        assert_eq!(report.protected, vec![HarnessId::Codex, HarnessId::Cursor]);
        assert_eq!(
            std::fs::read_to_string(custom_dir.join("SKILL.md")).unwrap(),
            "custom content"
        );
        assert_eq!(
            std::fs::read_to_string(untracked_dir.join("SKILL.md")).unwrap(),
            "historical content"
        );
    }
    #[test]
    fn unknown_and_missing_markers_protect_even_identical_content() {
        for marker in [None, Some(""), Some("unknown\n")] {
            let home = TempDir::new().unwrap();
            let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), "same").unwrap();
            if let Some(marker) = marker {
                std::fs::write(dir.join(SOURCE_MARKER_FILE), marker).unwrap();
            }
            for source in ["same", "new bundled"] {
                let report = sync_with_source(home.path(), source);
                assert_eq!(report.protected, vec![HarnessId::Cursor]);
                assert!(report.up_to_date.is_empty());
                assert!(report.errors.is_empty());
                assert_eq!(
                    std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
                    "same"
                );
            }
            assert_eq!(
                std::fs::read_to_string(dir.join(SOURCE_MARKER_FILE))
                    .ok()
                    .as_deref(),
                marker
            );
        }
    }

    #[test]
    fn marker_read_error_is_reported_without_changing_content() {
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(dir.join(SOURCE_MARKER_FILE)).unwrap();
        std::fs::write(dir.join("SKILL.md"), "keep").unwrap();
        let report = sync_with_source(home.path(), "new bundled");
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.errors[0].0, HarnessId::Cursor);
        assert!(report.errors[0].1.contains(SOURCE_MARKER_FILE));
        assert_eq!(
            std::fs::read_to_string(dir.join("SKILL.md")).unwrap(),
            "keep"
        );
    }

    #[test]
    fn failed_sync_replace_preserves_old_content_and_releases_lock() {
        use super::super::storage::test_support::{assert_no_temporary_files, with_replace_hook};
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("SKILL.md");
        std::fs::write(&dest, "old").unwrap();
        mark_bundled(&dest);
        let report = with_replace_hook(
            |_| Err(std::io::Error::other("injected replacement failure")),
            || sync_with_source(home.path(), "new"),
        );
        assert_eq!(report.errors.len(), 1);
        assert!(report.updated.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
        assert_no_temporary_files(&dir);
        assert_eq!(
            sync_with_source(home.path(), "new").updated,
            vec![HarnessId::Cursor]
        );
    }

    #[test]
    fn sync_holds_lock_until_content_replacement_finishes() {
        use super::super::storage::test_support::with_replace_hook;
        use std::sync::mpsc;
        use std::time::Duration;
        let home = TempDir::new().unwrap();
        let dir = HarnessId::Cursor.skill_dest_dir_for_home(home.path());
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("SKILL.md");
        std::fs::write(&dest, "old").unwrap();
        mark_bundled(&dest);
        let worker_home = home.path().to_path_buf();
        let (ready_tx, ready_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_replace_hook(
                move |_| {
                    ready_tx.send(()).unwrap();
                    resume_rx.recv_timeout(Duration::from_secs(10)).unwrap();
                    Ok(())
                },
                || sync_with_source(&worker_home, "first update"),
            )
        });
        ready_rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let during = sync_with_source(home.path(), "second update");
        assert_eq!(during.busy, vec![HarnessId::Cursor]);
        assert!(during.errors.is_empty());
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "old");
        resume_tx.send(()).unwrap();
        assert_eq!(worker.join().unwrap().updated, vec![HarnessId::Cursor]);
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "first update");
    }
}
