## 2025-05-18 - pathlib.Path WindowsPath instantiation in Python 3.12+ test mocks
**Learning:** Mocking `os.name = 'nt'` on non-Windows environments causes Python 3.12+ `pathlib.Path` to instantiate `WindowsPath`, which raises `NotImplementedError: cannot instantiate 'WindowsPath' on your system`.
**Action:** Mock `os.execvpe` directly to intercept process orchestration calls instead of mocking `os.name`.
