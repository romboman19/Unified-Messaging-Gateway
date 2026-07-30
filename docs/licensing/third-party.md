# Third-Party Software: Licensing & Operational Notes

Per spec §42. This file tracks third-party transport components that ship
with or alongside UMG, their license obligations, and the resulting
operational constraints. UMG's own code interacts with all of them only over
private HTTP/webhook boundaries (ADR-002).

---

## 1. UnoAPI (WhatsApp transport) — GPL-3.0

- UnoAPI is **GPL-3.0**. It runs as a **separate container**; its source is
  **never copied into the UMG core**, and UMG communicates with it only via
  its HTTP/webhook interface.
- All UnoAPI copyright and license notices are preserved in the shipped
  image and are not stripped.
- **If UMG (including the UnoAPI container image) is ever published or
  distributed to third parties, a separate license review is mandatory
  before release** — GPL-3.0 distribution obligations (source offer,
  license texts, notices) will then apply.
- UnoAPI session data (volume `umg-unoapi-data`) is part of the mandatory
  backup set.

**Risk note (§42, WhatsApp):** UnoAPI/Baileys is an *unofficial* WhatsApp
integration. The system owner accepts the risk of protocol changes and
account blocking. The production runbook must contain relink and rollback
procedures — see `docs/runbooks/whatsapp-reconnect.md` (completed in
Milestone 5).

---

## 2. signal-cli-rest-api & signal-cli (Signal transport) — MIT + own terms

- The REST wrapper (**signal-cli-rest-api** / bbernhard) is **MIT
  licensed**. Notices preserved with the image.
- **signal-cli itself and the Signal protocol libraries (libsignal) carry
  their own terms** (GPL-3.0 for signal-cli); as with UnoAPI they run in an
  isolated container reached over private HTTP only, with no code copied
  into UMG.
- The registration volume (`umg-signal-data`) contains cryptographic keys
  and registration state — treat it as **sensitive data**: restricted
  permissions, encrypted backups, never committed or logged.
- Re-linking procedure: `docs/runbooks/signal-relink.md` (completed in
  Milestone 4).

---

## 3. DBLtek SMS Server (GoIP vendor transport) — redistribution restricted

- **Redistribution of the vendor archive/image is not assumed allowed.**
  The archive `goip_install-v1.30.1.tar.gz` is kept by the infrastructure
  owner; it is **not committed** to the repository (path listed in
  `.gitignore`).
- The local build script verifies the archive **SHA-256** before building.
- The built vendor image is **private** and must not be published to any
  registry or shared without a license check with DBLtek.
- The vendor container (legacy PHP/MySQL stack) is network-isolated: not
  reachable from the LAN, and internet egress SHOULD be forbidden unless
  explicitly required (spec §30).
- Rollback procedure: `docs/runbooks/goip-rollback.md` (Milestone 2).

---

## 4. Compliance checklist before any external distribution

1. UnoAPI GPL-3.0 review (source offer + notices) — **blocking**.
2. signal-cli GPL-3.0 review — **blocking**.
3. DBLtek redistribution permission — **blocking**, do not ship the vendor
   image without written confirmation.
4. Re-run dependency license scan (`npm` license checker) and update this
   file.
