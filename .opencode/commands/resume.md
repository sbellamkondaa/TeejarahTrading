---
description: Resume Teejarah development from the current project state
agent: build
---

Resume TeejarahTrading development efficiently.

1. Run:
   - git status --short
   - git branch --show-current

2. Read `documentation/PROJECT_STATE.md`.

3. Treat the live Git branch and working tree as authoritative if they
   differ from the project-state document.

4. If arguments were provided, work on this task:
   $ARGUMENTS

5. If no arguments were provided, continue the current unfinished task
   identified in `documentation/PROJECT_STATE.md`.

6. Read only the relevant portions of
   `documentation/PRODUCT_REQUIREMENTS.md` when product requirements are
   needed for the task.

7. Search for the existing implementation before reading files broadly.

8. Read only files directly relevant to the task.

9. Prefer the smallest correct implementation that reuses existing code.

10. Do not redesign unrelated architecture or create speculative
    abstractions.

11. Run focused tests/checks after implementation.

12. Inspect `git diff` before finishing.

13. Do not commit, push, SSH-deploy, or change production containers
    without user approval.

At completion provide only:
- what changed
- files changed
- verification performed
- unresolved risks/issues

Keep narration concise.
