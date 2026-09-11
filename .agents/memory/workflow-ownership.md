---
name: Workflow ownership
description: Replit workflow ownership and port-conflict behavior for this workspace.
---

Keep one active workflow per application port. Artifact-managed workflow records can remain visible as finished after their configuration is removed or replaced, so inspect live states and open ports before restarting a named workflow.

**Why:** A stopped artifact frontend still owned port 20558 until it was explicitly stopped, causing the clean frontend workflow to fail with EADDRINUSE.

**How to apply:** Preserve the separate mockup workflow on its own port, stop confirmed duplicate app servers before starting replacements, and validate the final workflow list plus open ports.

Detaching all services from a registered web artifact removes its artifact-proxy preview route; the replacement manual web workflow can still serve the app directly on its configured port.

**Why:** The ScanLex manual frontend returned HTTP 200 on port 20558 after its generated service was removed, while the artifact-based screenshot route no longer resolved.

**How to apply:** Do not restore a managed service just to satisfy artifact-preview tooling when the user's goal is permanent removal; verify the manual web workflow directly instead.