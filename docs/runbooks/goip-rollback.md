# Runbook: GoIP / DBLtek Rollback

> **Stub.** The GoIP vendor adapter (DBLtek SMS Server v1.30.1 sidecar,
> ADR-003) lands in **Milestone 2**. This runbook will be completed in
> Milestone 2 with the exact procedures. Intended scope:
>
> - Rolling back a failed vendor SMS Server upgrade to the pinned
>   v1.30.1 image (exact tags/digests from the image manifest; archive
>   `goip_install-v1.30.1.tar.gz` SHA-256-verified, never committed).
> - Restoring vendor data volume `umg-goip-vendor-data` from backup along
>   with the database (see `backup-restore.md`).
> - Falling back from the experimental native GoIP UDP adapter (ADR-004)
>   to the vendor adapter per account (`adapter` field switch in the UI).
> - Verifying SMS send/receive + balance USSD after rollback; re-enabling
>   endpoints and draining queued messages (`queue-recovery.md`).
>
> Until Milestone 2, no GoIP channel exists in the deployment — use the
> mock channel for testing.
