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
WORK COST-EFFICIENTLY.

This workflow must minimize OpenRouter/API spend.

Cost rules:

- Use the cheapest suitable model for each subtask.
- Use GLM-5.3 Flash for exploration/navigation/summaries where possible.
- Use GLM-5.2 for normal implementation.
- Do not use Kimi, Claude, Terra, or other premium models unless explicitly
  required by a difficult unresolved issue.
- Do not delegate routine work to multiple agents.
- Do not run fast-review until implementation and focused tests are complete.
- Run fast-review at most once per milestone unless it finds a real defect that
  materially changes the implementation.
- Do not reread entire documentation files repeatedly.
- Do not scan the entire repository.
- Do not repeatedly run full test suites.
- Do not repeatedly run Docker builds for ordinary code edits.
- Prefer deterministic shell/scripts for Git, tests, deployment status, logs,
  health checks, and URL checks.
- Keep internal summaries concise.
- Avoid generating long explanations while working.
- Reuse context already discovered during the current milestone.
- Start a fresh OpenCode session for each milestone.
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

5. Run only the smallest focused tests required for the changed code.

6. Continue implementation/fixes using the primary model only.

7. When implementation is stable and focused tests pass, run fast-review once
   on the final meaningful diff.

8. Fix only legitimate review findings.

9. Inspect git diff and git diff --check.

10. Commit the completed feature with a concise commit message.

11. Push only:
    origin feature/data-plane-foundation

12. Run:
    /usr/local/bin/teejarah-remote-sync

13. Run one remote build only after local focused verification passes:
     /usr/local/bin/teejarah-remote-build

Do not rebuild repeatedly unless the previous build failed or code changed after
the build.
14. If the build fails:
    diagnose,
    fix locally,
    retest,
    commit/push,
    sync,
    rebuild.
    Repeat automatically until successful or a real design decision is required.

15. Deploy using:
    /usr/local/bin/teejarah-remote-deploy

16. Wait for container health.

17. Run:
    /usr/local/bin/teejarah-remote-status

18. Inspect relevant application/worker logs.

19. Run:
    /usr/local/bin/teejarah-url-check

20. Verify any newly added API routes using safe HTTP checks.

21. If deployment or smoke validation finds a bug:
    diagnose,
    make the smallest fix,
    test,
    commit/push,
    sync,
    rebuild,
    redeploy,
    and validate again automatically.

22. Update documentation/PROJECT_STATE.md when the completed feature materially
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
