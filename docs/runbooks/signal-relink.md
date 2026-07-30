# Runbook: Signal Re-link

> **Stub.** The Signal adapter (signal-cli-rest-api sidecar) lands in
> **Milestone 4**. This runbook will be completed in Milestone 4 with the
> exact procedures. Intended scope:
>
> - Re-registering / re-linking a Signal number when registration or keys
>   are invalidated (device unlink, key change, sealed-sender issues).
> - Protecting and restoring `umg-signal-data` (registration keys are
>   sensitive data — licensing notes in `docs/licensing/third-party.md`).
> - Switching between signal-cli json-rpc modes under load.
> - Recovery test: send/receive smoke on the relinked number, then
>   re-enable the endpoint and resume queued traffic
>   (`queue-recovery.md`).
>
> Until Milestone 4, use the mock channel for testing.
