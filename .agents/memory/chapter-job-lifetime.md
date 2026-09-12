---
name: Chapter job lifetime
description: Runtime boundary for background chapter translation jobs.
---

Background chapter translation is intentionally stored in server memory: browser navigation or tab closure does not cancel a job, but restarting or redeploying the API process clears active jobs and their cached pages.

**Why:** The requested implementation avoids introducing a database and keeps job state consistent with the existing in-memory translated-page cache.

**How to apply:** Treat browser disconnect recovery and server-restart durability as separate guarantees; add persistent storage only if restart/redeploy recovery becomes a requirement.