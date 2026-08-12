## 2026-08-05 - [Mocking os.name causes pathlib failure on Python 3.12+]
**Learning:** Mocking `os.name = "nt"` to simulate Windows process orchestration on a POSIX system causes `pathlib.Path` in Python 3.12+ to attempt instantiating `WindowsPath`, resulting in a fatal `NotImplementedError`.
**Action:** Mock target process execution functions like `os.execvpe` or subprocess commands directly instead of altering global `os.name` state.

## 2026-08-05 - [Post-migration index creation prevents database boot errors]
**Learning:** Performance indexes targeting table columns added or modified during database schema migrations (such as `user_id` in `conversations`) will crash database initialization if executed prior to the migrations.
**Action:** Ensure all performance indexes are defined and executed at the very end of database initialization, after all schema migration methods have run.
