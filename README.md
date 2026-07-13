# PharmaTrack — Pharmacy Inventory & POS System

**COE 454 Software Engineering II — Client Project (KNUST, Dept. of Computer Engineering)**

A modern, web-based inventory and point-of-sale system for a retail pharmacy in the KNUST
environs, replacing a discontinued QuickBooks Desktop Point of Sale 19.0 installation.
Built as a **modular monolith**, deployed to a live URL, resilient to internet outages at
the point of sale.

> ⚠️ **Placeholders.** Anything in `[SQUARE BRACKETS]` (business name, contact names,
> interview data, signatures) must be filled with **real** information gathered during
> site visits. Per the course brief §6, fabricated client evidence is academic misconduct.
> The technical documents here are design work and are safe to submit as-is once reviewed
> by the team.

---

## Document map

### Week 1 — Scout & Agree
| Course deliverable | Document |
|---|---|
| Team Charter (signed) | [docs/week1/team-charter.md](docs/week1/team-charter.md) — fill in, print, sign |
| Problem Discovery Note (max 1 page) | [docs/week1/problem-discovery-note.md](docs/week1/problem-discovery-note.md) |
| Site Visit 1 Log | Appendix C of the course brief — completed on paper at the pharmacy ✅ |
| GitHub repo + project board | This repository; board setup checklist in [docs/project-plan.md](docs/project-plan.md) |

### Week 2 — Requirements & Agreements
| Course deliverable | Document |
|---|---|
| Requirements Document (min 5 pages) | [docs/week2/requirements-document.md](docs/week2/requirements-document.md) |
| User Personas (min 2) + wireframes | Personas §3 of Requirements Doc; [docs/week2/wireframes-ui-ux.md](docs/week2/wireframes-ui-ux.md) |
| Class Pitch (5 min) | [docs/week2/class-pitch.md](docs/week2/class-pitch.md) |
| Signed MoU | Appendix A of the course brief — physical signing, PM + one member present |

### Week 3 — Architecture & Planning
| Course deliverable | Document |
|---|---|
| Architecture Decision Records (min 5) | [docs/week3/adrs.md](docs/week3/adrs.md) — 8 ADRs |
| ERD (min 4 entities) | [docs/week3/database-design.md](docs/week3/database-design.md) — 15 entities |
| Database schema (DDL) | [docs/week3/schema.sql](docs/week3/schema.sql) |
| API Schema document | [docs/week3/api-schema.md](docs/week3/api-schema.md) |
| Project board screenshot | Take after loading user stories US-01…US-16 as issues |
| Scaffold code + README setup | Next step after documentation review |

### Analysis & design models (SRS supplements)
| Content | Document |
|---|---|
| Use case diagram + descriptions, activity diagrams, context diagram, DFD-0, DFD-1, class diagram, sequence diagrams, architecture & module diagrams | [docs/analysis-models.md](docs/analysis-models.md) |
| Project schedule (Gantt), milestones, team roles, risk register, acceptance criteria, future improvements | [docs/project-plan.md](docs/project-plan.md) |

All diagrams are **Mermaid** — GitHub renders them natively; no image exports needed.

---

## The problem in one paragraph

The client pharmacy runs its entire sales and stock operation on **QuickBooks Desktop
Point of Sale 19.0**, which Intuit discontinued on 3 October 2023: no security patches,
no support, no new licenses, and no path to reinstall if the single Windows 10 till fails.
The product has **no medicine batch or expiry-date tracking**, so expiry management is done
by physically checking shelves; reorder decisions rely on a static reorder-point field; and
all data lives on one machine with no off-site backup. PharmaTrack replaces this with a
web-based POS + inventory system with batch/expiry tracking (FEFO), low-stock and expiry
alerts, supplier purchase orders, role-based access, audit logging, and an offline-tolerant
POS — accessible from the till, a phone, or the owner's laptop.

## Tech stack (summary — full rationale in ADRs)

| Layer | Choice |
|---|---|
| Frontend | React 18 + TypeScript + Vite, Tailwind CSS, PWA (offline POS queue via IndexedDB/Dexie) |
| State / data | TanStack Query (server state) + Zustand (POS cart) |
| Backend | Node.js 22 + NestJS (modular monolith), class-validator DTOs |
| ORM / DB | Prisma + PostgreSQL 16 |
| Auth | JWT (short-lived access + rotating refresh), RBAC, argon2 password hashing |
| Deployment | Vercel (frontend) + Railway (API + Postgres) |
| Barcode | USB scanner as keyboard wedge; `@zxing/browser` camera scanning on mobile |
| Receipts | 80 mm thermal print via browser print CSS; SMS receipt/alerts via Africa's Talking (Week 5 integration) |

## Repository layout (planned)

```
pharmacy-ims/
├── docs/                  # everything above
├── apps/
│   ├── api/               # NestJS modular monolith
│   └── web/               # React PWA (POS + back office)
├── packages/
│   └── shared/            # shared types, DTO zod schemas
├── .env.example           # committed; .env is gitignored
└── README.md
```
