# On-Site Deployment Runbook — On-Premise (Offline-Capable) Install

**What the team does when we physically go to the pharmacy to stand PharmaTrack up
on their own server, so it runs with no internet dependency.** This is the on-premise
counterpart to the cloud deployment (`render.yaml` + Vercel + Neon). Everything the
tills need — database, API, and web app — runs on one local machine on the pharmacy's
own network. Cross-references: ADR-004 (Postgres), ADR-005 (JWT/roles), ADR-006 (offline
POS), ADR-009 (deploy).

> **Print this and take it. Do the "Before the visit" section days ahead — not at the
> counter.** The on-site steps assume the prep artifacts already exist.

---

## 1. Why on-premise (the goal)

The cloud setup needs internet because the database lives on Neon. On-premise, the whole
stack sits in the pharmacy building and the tills reach it over the **local network
(router / WiFi)**. No internet means no lost sales, and — unlike the browser-only offline
mode — **reads *and* writes both work** (products, purchasing, adjustments, reports).

```mermaid
flowchart LR
    subgraph Pharmacy LAN (no internet needed)
        SRV["Server box<br/>(mini-PC + UPS)<br/>Docker: DB + API + Web"]
        RTR["Router / WiFi<br/>access point"]
        T1["Till 1<br/>(browser)"]
        T2["Till 2<br/>(browser)"]
        MGR["Manager laptop"]
        SRV --- RTR
        RTR --- T1
        RTR --- T2
        RTR --- MGR
    end
    SRV -. "nightly backup" .-> USB[("USB / 2nd disk")]
    SRV -. "optional, when internet is up" .-> CLOUD[("Off-site backup")]
```

**Resilience rule (do not skip):** the server box is a single point of failure. Keep the
device-level offline POS (ADR-006 PWA + IndexedDB) enabled on every till so a till can
still *sell* if the server, router, or WiFi dies, then sync back when it returns.

---

## 2. Before the visit (prep checklist — do NOT leave for site)

**Artifacts to prepare and test in the office first:**

- [ ] **Full-stack compose file** — a production `docker-compose.prod.yml` that runs
      **db + api + web together** on one host. (Current repo `docker-compose.yml` only
      runs the database; the API has a Dockerfile, the web is a static build — these need
      to be composed into one bundle and dry-run tested before the visit.)
- [ ] **Local HTTPS plan** — the PWA install, service worker, and offline layer need a
      *secure context*; a plain `http://192.168.x.x` will not run them. Prepare a reverse
      proxy with a local certificate (e.g. **Caddy** with an internal CA, or `mkcert`) so
      tills reach `https://` on the LAN. Decide a hostname (e.g. `https://pharmatrack.local`).
- [ ] **Generated secrets** — real `JWT_ACCESS_SECRET` (`openssl rand -hex 32`), DB
      password. Do **not** ship the `change-me-*` defaults from `.env.example`.
- [ ] **Seed / migration bundle** — DB schema migrations + the initial admin user + any
      starter catalogue the pharmacy gave us.
- [ ] **Offline installer bundle** — Docker Desktop / Engine installer, the Docker
      **images exported to a file** (`docker save`), and this repo, all on a USB drive.
      Assume no usable internet at the site to download anything.
- [ ] **Rehearsal** — stand the whole thing up on a spare laptop end-to-end at least once.
      First time you see it work should not be in front of the client.

**Hardware to confirm the pharmacy has (or we bring):**

- [ ] Server machine — mini-PC / NUC, min ~8 GB RAM, SSD, able to run 24/7.
- [ ] **UPS** for the server (Ghana grid reality — an unclean shutdown can corrupt Postgres).
- [ ] Router / WiFi access point with enough coverage for all till positions.
- [ ] The tills themselves (PCs/tablets with a modern browser — Edge/Chrome).
- [ ] Barcode scanners (keyboard-wedge type, per the POS design).
- [ ] Receipt printer (80 mm, per ADR-008) + a spare USB drive for backups.

---

## 3. On-site: step by step

### 3.1 Site assessment (first 30 min)
- [ ] Confirm mains power + that the UPS holds the server through a cut.
- [ ] Confirm the router is up and note whether it hands out DHCP or we set static IPs.
- [ ] Pick the server's **static LAN IP** (e.g. `192.168.1.10`) and reserve it in the router.
- [ ] Note physical placement: server ventilated, on UPS, not where it'll be unplugged.

### 3.2 Prepare the server machine
- [ ] Install/verify the OS is updated and set to **not sleep / auto-start on power**.
- [ ] Install **Docker Engine + Compose** from the USB bundle (no download at site).
- [ ] Load the prepared images: `docker load -i pharmatrack-images.tar`.
- [ ] Copy the repo + `docker-compose.prod.yml` to the server.

### 3.3 Configure environment
- [ ] Create the production `.env` from `.env.example`, with **real** values:
  - `DATABASE_URL` → the local Postgres container.
  - `JWT_ACCESS_SECRET` → generated secret (not `change-me-access`).
  - `API_PORT=3000`, `CORS_ORIGIN=https://pharmatrack.local` (the LAN hostname).
  - `VITE_API_URL=https://pharmatrack.local/api/v1` (baked into the web build).
  - SMS (`AT_*`) — leave blank for log-only mode unless the pharmacy has credentials.
- [ ] Confirm `VITE_API_URL` points at the **LAN address**, not localhost/Vercel.

### 3.4 Bring the stack up
- [ ] `docker compose -f docker-compose.prod.yml up -d`
- [ ] Wait for the DB healthcheck to pass, then run migrations against the local DB.
- [ ] Seed the **initial admin user** and starter catalogue.
- [ ] Verify all containers are healthy: `docker compose ps`.

### 3.5 HTTPS on the LAN
- [ ] Start the reverse proxy (Caddy/`mkcert`) so `https://pharmatrack.local` serves the web app.
- [ ] Install/trust the local CA certificate on **each till and the manager laptop**
      (otherwise browsers warn and the service worker / install won't run).
- [ ] Add `pharmatrack.local` → server IP in each device's hosts file **or** the router DNS.

### 3.6 Configure the tills
- [ ] On each till browser, open `https://pharmatrack.local` and confirm it loads clean (no cert warning).
- [ ] **Install as an app** (Edge: address-bar install icon) for a windowed, kiosk-like experience.
- [ ] Pair the barcode scanner; confirm a scan populates POS search.
- [ ] Configure the 80 mm receipt printer and print a test receipt.

---

## 4. Smoke test (must pass before we leave)

- [ ] Log in as admin; create a test cashier for each role needed.
- [ ] **POS online path:** ring a sale, take payment, print receipt, void/return a line.
- [ ] **Inventory writes:** create a product, receive a purchase, post a stock adjustment —
      confirm they persist (this is the on-prem win the browser-only mode can't do).
- [ ] Reports / Dashboard render real numbers.
- [ ] **Offline fallback drill:** unplug the till's network (not the server) →
      confirm POS still sells from the cached catalogue and queues the sale →
      reconnect → confirm the queued sale syncs and the unsynced badge clears.
- [ ] **Power drill:** pull mains, confirm the UPS holds and the server stays up; then do a
      clean `docker compose restart` and confirm data survived.

---

## 5. Backups (set up before leaving — non-negotiable)

There is no managed Neon backup on-prem; losing the box = losing the business data.

- [ ] Automated **nightly `pg_dump`** to a second disk / USB on the server (cron or a
      scheduled container).
- [ ] Keep at least 7 daily + 4 weekly dumps (rotate).
- [ ] Show the pharmacy how to **swap/take a USB copy off-site** weekly.
- [ ] Optional: when internet is available, push an encrypted dump off-site.
- [ ] **Test a restore** into a scratch database on-site — an untested backup is not a backup.

---

## 6. Handover & training

- [ ] Walk the manager through: daily open/close, adding products, receiving stock, reports.
- [ ] Show what the **OFFLINE badge** and **unsynced counter** mean, and that sales are safe offline.
- [ ] Show how to spot/act on the reconcile alert after an offline oversell (`NEG_STOCK_EXCEPTION`).
- [ ] Leave a **one-page cheat sheet**: how to power-cycle the server safely, who to call,
      and "if a till won't load, check WiFi first, server second."
- [ ] Hand over credentials securely; have the manager change the admin password on the spot.

---

## 7. Remote support & maintenance (agree with the pharmacy)

- On-prem means updates are hands-on. Decide: periodic site visits, or a **VPN / secure
  tunnel** for remote maintenance.
- The owner viewing reports from home does **not** work by default — needs VPN or a hybrid
  cloud-sync setup. Flag this expectation before we leave.
- Log where the server, UPS, router, and backup drive physically are.

---

## 8. Contingency / rollback

- [ ] If the on-site install stalls, the **cloud deployment stays live** — tills can fall back
      to the internet URL as a stopgap (needs connectivity).
- [ ] If a container won't start: `docker compose logs <service>`; most issues are the `.env`
      (`DATABASE_URL`, `CORS_ORIGIN`, `VITE_API_URL`) or the cert not trusted on the till.
- [ ] Keep the previous images so we can roll back a bad update: `docker compose down` →
      restore prior images → `up -d` → restore last good DB dump if schema changed.

---

## 9. Sign-off checklist (leave only when all are true)

- [ ] All tills load over HTTPS, installed as apps, scanners + printers working.
- [ ] Online sale, offline sale + resync, and inventory writes all verified.
- [ ] UPS holds the server through a power cut; clean restart preserves data.
- [ ] Nightly backup runs and a test restore succeeded.
- [ ] Manager trained, cheat sheet left, admin password changed, support channel agreed.
