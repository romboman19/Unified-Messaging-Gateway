# Runbook: WhatsApp Reconnect (UnoAPI)

> **Stub.** The WhatsApp adapter (UnoAPI/Baileys sidecar) lands in
> **Milestone 5**. This runbook will be completed in Milestone 5 with the
> exact procedures. Intended scope:
>
> - Reconnecting a session after QR expiry or a WhatsApp-side logout:
>   restart of the `unoapi` container, QR/code re-link flow, session
>   persistence in `umg-unoapi-data`.
> - Protocol-risk playbook: WhatsApp/Baileys is an unofficial integration
>   (`docs/licensing/third-party.md`) — expected failure modes are account
>   blocking and protocol changes; rollback is to the previous pinned
>   UnoAPI image from the version manifest.
> - Verifying send/receive and delivery receipts after reconnect, then
>   re-enabling endpoints and draining queued messages
>   (`queue-recovery.md`).
>
> Until Milestone 5, use the mock channel for testing.
