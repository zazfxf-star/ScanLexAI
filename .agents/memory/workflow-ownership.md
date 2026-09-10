---
name: Workflow ownership
description: Replit workflow ownership and port-conflict behavior for this workspace.
---

Keep one active workflow per application port. Artifact-managed workflow records can remain visible as finished after their configuration is removed or replaced, so inspect live states and open ports before restarting a named workflow.

**Why:** A stopped artifact frontend still owned port 20558 until it was explicitly stopped, causing the clean frontend workflow to fail with EADDRINUSE.

**How to apply:** Preserve the separate mockup workflow on its own port, stop confirmed duplicate app servers before starting replacements, and validate the final workflow list plus open ports.