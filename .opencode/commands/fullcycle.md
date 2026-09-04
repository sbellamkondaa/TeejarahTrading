---
description: Implement, test, deploy, and validate a Teejarah feature autonomously
agent: build
---

Complete the requested TeejarahTrading task autonomously.

Task:

$ARGUMENTS

Use the live Git branch and working tree as authoritative.

Expected development branch:

feature/data-plane-foundation

WORK AUTONOMOUSLY.

Do not stop after normal coding, testing, Git, build, deployment, or validation
steps.

Workflow:

1. Inspect only the project state and files relevant to the requested task.

2. Search for existing implementations before creating new abstractions.

3. Implement the smallest correct solution.

4. Reuse existing:
   - services
   - APIs
   - components
   - caching
   - schedulers
   - database tables
   - utilities
   whenever practical.

5. Run focused tests.

6. Run fast-review.

7. Fix legitimate review/test problems.

8. Inspect git diff and git diff --check.

9. Commit the completed feature with a concise commit message.

10. Push only:
    origin feature/data-plane-foundation

11. Run:
    /usr/local/bin/teejarah-remote-sync

12. Run:
    /usr/local/bin/teejarah-remote-build

13. If the build fails:
    diagnose,
    fix locally,
    retest,
    commit/push,
    sync,
    rebuild.
    Repeat automatically until successful or a real design decision is required.

14. Deploy using:
    /usr/local/bin/teejarah-remote-deploy

15. Wait for container health.

16. Run:
    /usr/local/bin/teejarah-remote-status

17. Inspect relevant application/worker logs.

18. Run:
    /usr/local/bin/teejarah-url-check

19. Verify any newly added API routes using safe HTTP checks.

20. If deployment or smoke validation finds a bug:
    diagnose,
    make the smallest fix,
    test,
    commit/push,
    sync,
    rebuild,
    redeploy,
    and validate again automatically.

21. Update documentation/PROJECT_STATE.md when the completed feature materially
    changes project state.

DO NOT ask permission for:

- source edits
- focused tests
- fast-review
- git add
- normal git commit
- push to feature/data-plane-foundation
- remote status
- remote logs
- remote sync
- remote build
- production deployment through the approved deployment helper
- URL/API smoke validation
- fixing and redeploying ordinary bugs

STOP and ask only when the task requires:

- destructive Git operations
- force push
- deleting production data
- destructive database operations
- creating/changing database schema unless explicitly part of the requested task
- exposing network ports
- firewall/security-policy changes
- arbitrary root commands
- arbitrary SSH/Docker/sudo outside approved wrappers
- reading or displaying secrets
- live automated trading or order placement
- a significant product/architecture decision that cannot be inferred safely

Never print credentials, tokens, secret environment values, private keys,
session cookies, or TOTP secrets.

At completion report only:

- feature implemented
- important files changed
- tests
- review result
- deployed commit
- container health
- URL/API validation
- bugs found/fixed during deployment
- remaining limitations
