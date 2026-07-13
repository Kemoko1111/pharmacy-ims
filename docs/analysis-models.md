# Analysis & Design Models

**SRS supplements — use cases, activity, context/DFD, architecture, class & sequence
models.** All diagrams are Mermaid (GitHub renders natively). IDs cross-reference the
user stories (US-xx) in the Requirements Document.

---

## 1. Use case diagram

```mermaid
graph LR
    subgraph Actors
        CA(["Cashier"])
        PH(["Pharmacist"])
        IO(["Inventory Officer"])
        MG(["Manager"])
        AD(["Administrator"])
        SUP(["Supplier<br/>(external)"])
        SMS(["SMS Gateway<br/>(external)"])
    end

    subgraph "PharmaTrack — Pharmacy Inventory & POS System"
        UC1((Log in / out))
        UC2((Process sale))
        UC3((Print receipt))
        UC4((Sync offline sales))
        UC5((Process return/refund))
        UC6((Manage products & prices))
        UC7((Receive stock<br/>batches + expiry))
        UC8((Raise purchase order))
        UC9((Adjust stock))
        UC10((Approve adjustment/refund))
        UC11((View dashboards & reports))
        UC12((Manage users & roles))
        UC13((Configure settings))
        UC14((Review audit log))
        UC15((Receive expiry/low-stock alerts))
    end

    CA --> UC1 & UC2 & UC3 & UC5
    UC2 -.include.-> UC3
    UC2 -.extend.-> UC4
    PH --> UC1 & UC2 & UC7 & UC9 & UC10 & UC15
    IO --> UC1 & UC6 & UC7 & UC8 & UC9
    MG --> UC1 & UC10 & UC11 & UC15
    AD --> UC12 & UC13 & UC14
    UC8 --> SUP
    UC15 --> SMS
```

*Role inheritance: Manager can do everything a Pharmacist/Inventory Officer can; Admin
can do everything (permission matrix in ADR-005).*

## 2. Use case descriptions (5 primary)

### UC-2 Process sale (US-04/05/06/07/08)
| Field | Description |
|---|---|
| Actors | Cashier (primary), Customer (off-stage) |
| Preconditions | Cashier authenticated; catalogue cached locally |
| Main flow | 1. Cashier scans item (or searches by name/generic). 2. System adds line, showing unit options (carton/pack/strip/tablet) and FEFO batch availability. 3. Repeat for all items. 4. Cashier presses F4; enters tendered amount and method. 5. System validates stock atomically, records sale + movements, assigns receipt number. 6. Receipt prints; change displayed. |
| Alternate flows | A1 unknown barcode → search prompt. A2 offline → sale queued locally with client ID; receipt prints with local number; syncs on reconnect (UC-4). A3 insufficient stock → line blocked with on-hand shown. A4 expired batch only → sale blocked (BR-02). |
| Postconditions | Stock reduced by movements; immutable sale record; audit trail |

### UC-7 Receive stock (US-05/09)
| Field | Description |
|---|---|
| Actors | Inventory Officer (primary), Manager (over-receipt approval) |
| Preconditions | PO exists (or direct receipt allowed); supplier registered |
| Main flow | 1. Officer opens PO, enters per line: qty received, batch number, expiry date. 2. System validates (expiry > today; qty ≤ outstanding). 3. Officer posts. 4. System creates GRN, creates/tops up batches, writes RECEIPT movements, recalculates weighted-average cost, updates PO status. |
| Alternate flows | A1 over-receipt → Manager PIN required. A2 partial delivery → PO → PARTIALLY_RECEIVED. A3 short expiry (<90 d) → warning requiring confirmation. |
| Postconditions | Sellable stock available to POS with correct expiry ordering |

### UC-9 Adjust stock (US-12)
Actors: any stock role requests; Manager approves above threshold (BR-05). Main flow:
select product+batch → qty delta + reason + note → if |value| > threshold, status
PENDING_APPROVAL → Manager approves → ADJUSTMENT movement posts. Rejected adjustments
post nothing. All paths audited; shrinkage reportable by reason.

### UC-4 Sync offline sales (US-08)
Actor: system (background). Trigger: connectivity restored. Flow: queued sales POSTed in
order to `/sync/sales` → server creates each idempotently on `clientSaleId` → FEFO
deduction at sync time → response marks created/duplicate/error → till clears queue,
updates badge. Exception: batch oversold during outage → sale recorded, negative-stock
exception notification to Manager (ADR-006).

### UC-11 View reports (US-13)
Actor: Manager/Owner. Flow: pick report + date range → server reads reporting views →
render table + chart → optional CSV/PDF export. Z-report closes the trading day.

## 3. Activity diagram — Process sale (with offline branch)

```mermaid
flowchart TD
    A([Start: customer at till]) --> B[Scan / search item]
    B --> C{Product found?}
    C -- no --> B2[Search by name/generic] --> C
    C -- yes --> D[Select unit & quantity]
    D --> E{Sellable stock<br/>non-expired ≥ qty?}
    E -- no --> E1[Show on-hand & alternatives] --> B
    E -- yes --> F[Add line to cart]
    F --> G{More items?}
    G -- yes --> B
    G -- no --> H["Tender (F4): method + amount"]
    H --> I{Online?}
    I -- yes --> J[POST /sales<br/>atomic FEFO deduction]
    J --> K{Accepted?}
    K -- "422 (expired/oversell)" --> E1
    K -- yes --> L[Server receipt number]
    I -- no --> M[Queue sale in IndexedDB<br/>client UUID + local number]
    M --> N[Increment unsynced badge]
    L --> O[Print receipt & change]
    N --> O
    O --> P([End])
    M -.reconnect.-> Q[[UC-4 background sync]]
```

## 4. Activity diagram — Receive purchase order

```mermaid
flowchart TD
    A([Delivery arrives]) --> B[Open PO / start direct GRN]
    B --> C[Enter line: qty, batch no., expiry]
    C --> D{Expiry valid & qty ≤ outstanding?}
    D -- "expiry ≤ today" --> C1[Reject line] --> C
    D -- "qty > outstanding" --> C2{Manager approves<br/>over-receipt?}
    C2 -- no --> C
    C2 -- yes --> E
    D -- ok --> E{More lines?}
    E -- yes --> C
    E -- no --> F[Review summary: batches +<br/>movements to be created]
    F --> G[Post GRN — atomic]
    G --> H[Batches created/updated<br/>weighted-avg cost recalc]
    H --> I[PO → received / partial]
    I --> J([Stock sellable at POS])
```

## 5. Context diagram (Level 0 system boundary)

```mermaid
flowchart LR
    CASH[Cashier] -->|sales, scans| S
    PHAR[Pharmacist] -->|receiving, approvals| S
    INV[Inventory Officer] -->|products, POs| S
    OWN[Owner / Manager] -->|queries| S
    ADM[Administrator] -->|users, settings| S

    S{{"PharmaTrack<br/>Pharmacy Inventory & POS"}}

    S -->|receipts| CUST[Customer]
    S -->|purchase orders| SUP[Supplier]
    S -->|alert SMS| SMSGW[Africa's Talking<br/>SMS Gateway]
    S -->|reports, dashboards| OWN
    QB[(Legacy QB POS<br/>item CSV)] -->|one-time import| S
```

## 6. Data flow diagram — Level 0

```mermaid
flowchart TB
    cashier[Cashier] & officer[Inventory Officer] & manager[Manager/Owner]

    P1((1.0<br/>Sell)) ; P2((2.0<br/>Procure &<br/>Receive)) ; P3((3.0<br/>Control<br/>Stock)) ; P4((4.0<br/>Report &<br/>Alert))

    D1[(D1 Catalogue)] ; D2[(D2 Stock ledger<br/>batches+movements)] ; D3[(D3 Sales)] ; D4[(D4 Purchasing)]

    cashier -->|scanned items, tender| P1
    P1 -->|price/unit lookup| D1
    P1 -->|deductions| D2
    P1 -->|sale records| D3
    P1 -->|receipt| cashier

    officer -->|PO, delivery details| P2
    P2 --> D4
    P2 -->|batches in| D2

    officer & manager -->|adjustments, approvals| P3
    P3 --> D2

    D2 & D3 & D4 --> P4
    P4 -->|Z-report, valuations, expiry & low-stock alerts| manager
```

## 7. Data flow diagram — Level 1 of process 1.0 (Sell)

```mermaid
flowchart TB
    cashier[Cashier]
    P11((1.1 Identify<br/>product)) ; P12((1.2 Build<br/>cart)) ; P13((1.3 Take<br/>payment)) ; P14((1.4 Commit sale<br/>FEFO deduct)) ; P15((1.5 Issue<br/>receipt)) ; P16((1.6 Offline queue<br/>& sync))

    D1[(D1 Catalogue)] ; D2[(D2 Stock ledger)] ; D3[(D3 Sales)] ; Q[(Local queue<br/>IndexedDB)]

    cashier -->|barcode / query| P11
    P11 <--> D1
    P11 --> P12
    P12 -->|availability check| D2
    P12 --> P13
    cashier -->|tender| P13
    P13 --> P14
    P14 -->|movements −qty| D2
    P14 -->|sale + items + payments| D3
    P14 --> P15 -->|printed receipt| cashier
    P13 -. offline .-> P16
    P16 --> Q
    Q -->|on reconnect, idempotent| P14
```

## 8. System architecture diagram

```mermaid
flowchart TB
    subgraph till["Pharmacy till / phones (browser)"]
        PWA["React PWA<br/>POS · back office"]
        SW["Service worker<br/>app-shell cache"]
        IDB[("IndexedDB<br/>catalogue snapshot<br/>offline sale queue")]
        SCAN["USB scanner<br/>(keyboard wedge)"] --> PWA
        PRN["80mm printer<br/>(browser print)"]
        PWA --- SW
        PWA --- IDB
        PWA --> PRN
    end

    subgraph railway["Railway"]
        subgraph api["NestJS modular monolith"]
            AUTH[auth] ; CAT[catalog] ; INVM[inventory] ; PUR[purchasing]
            SAL["sales + sync"] ; REP[reporting] ; NOT[notifications] ; AUD[audit]
        end
        PG[("PostgreSQL 16")]
        api --> PG
    end

    VER["Vercel<br/>static hosting + CDN"] --> PWA
    PWA <-->|"HTTPS JSON /api/v1"| api
    NOT --> AT["Africa's Talking SMS"]
    PG -.nightly pg_dump.-> BK[("Off-site backup")]
    GH["GitHub Actions CI/CD"] -.deploys.-> VER & railway
```

*Module diagram: see the dependency table in ADR-001; arrows inside `api` are enforced
by lint rules — `sales → catalog/inventory/customers`, `purchasing → suppliers/catalog/
inventory`, `audit` subscribes to events from all, `reporting` reads views only.*

## 9. Class diagram (domain layer, key types)

```mermaid
classDiagram
    class User { +id +username +fullName +role: Role +isActive }
    class Product { +id +name +genericName +strength +form +baseUnit +sellingPriceBase +reorderLevel +vatApplies +prescriptionOnly +deletedAt }
    class ProductUnit { +id +unitName +factorToBase +sellingPrice +isActive }
    class Batch { +id +batchNumber +expiryDate +qtyOnHand +unitCost +status +isSellable() bool }
    class StockMovement { +id +qtyDelta +type +refType +refId +createdAt }
    class Sale { +id +clientSaleId +receiptNumber +subtotal +vatTotal +total +status +soldAt +syncedOffline }
    class SaleItem { +quantity +qtyBase +unitPrice +discount +lineTotal }
    class Payment { +method +amount +tendered +changeDue }
    class PurchaseOrder { +poNumber +status +expectedDate }
    class GoodsReceipt { +grnNumber +receivedAt }
    class StockAdjustment { +qtyDelta +reason +status }
    class UnitConverter { +toBase(unit, qty) int +breakdown(product, qtyBase) UnitQty[] }
    class FefoAllocator { +allocate(product, qtyBase) BatchAllocation[] }
    class SyncService { +ingest(SaleCreate[]) SyncResult[] }

    Product "1" o-- "0..*" ProductUnit
    Product "1" o-- "0..*" Batch
    Batch "1" o-- "0..*" StockMovement
    Sale "1" *-- "1..*" SaleItem
    Sale "1" *-- "1..*" Payment
    SaleItem --> ProductUnit
    SaleItem --> Batch
    PurchaseOrder "1" o-- "0..*" GoodsReceipt
    User "1" o-- "0..*" Sale : cashier
    StockAdjustment --> Batch
    FefoAllocator ..> Batch : locks FOR UPDATE
    SyncService ..> Sale : idempotent create
    UnitConverter ..> ProductUnit
```

## 10. Sequence diagram — Online POS sale

```mermaid
sequenceDiagram
    actor C as Cashier
    participant W as React PWA
    participant A as sales module (API)
    participant I as inventory (FefoAllocator)
    participant DB as PostgreSQL

    C->>W: scan barcode
    W->>W: lookup in cached snapshot (instant)
    W-->>C: line added (price, stock, units)
    C->>W: F4 · tender cash 30.00
    W->>A: POST /sales {clientSaleId, items, payments}
    A->>DB: BEGIN
    A->>I: allocate(product, qtyBase)
    I->>DB: SELECT batches … FOR UPDATE (FEFO order)
    I-->>A: [batch allocations]
    A->>DB: INSERT sale, sale_items, payments,<br/>stock_movements; UPDATE batches
    A->>DB: COMMIT
    A-->>W: 201 {receiptNumber, change: 2.00}
    W-->>C: print receipt · show change
    Note over A,DB: audit interceptor logs sale.created
```

## 11. Sequence diagram — Offline sale & sync (ADR-006)

```mermaid
sequenceDiagram
    actor C as Cashier
    participant W as React PWA
    participant Q as IndexedDB queue
    participant A as sync endpoint
    participant DB as PostgreSQL

    Note over W: connectivity lost — amber banner
    C->>W: complete sale (cart → tender)
    W->>Q: persist {clientSaleId: uuid7, soldAt, items, payments}
    W-->>C: receipt (local number) · badge "1 unsynced"
    Note over W: … outage continues, more sales queue …
    W->>W: connectivity restored (online event)
    W->>A: POST /sync/sales {sales: [s1, s2]}
    A->>DB: for each: INSERT … ON CONFLICT (client_sale_id) DO NOTHING
    alt new sale
        A->>DB: FEFO deduct (may drive batch negative)
        DB-->>A: negative? → notification NEG_STOCK_EXCEPTION
    else duplicate (retry)
        A-->>A: return existing receipt number
    end
    A-->>W: results [{created, RCP-000124}, {created, RCP-000125}]
    W->>Q: clear synced entries
    W-->>C: badge "0 unsynced" · green banner
```

## 12. Sequence diagram — Login & token refresh (ADR-005)

```mermaid
sequenceDiagram
    actor U as Staff
    participant W as PWA
    participant A as auth module
    participant DB as PostgreSQL

    U->>W: username + password
    W->>A: POST /auth/login
    A->>DB: fetch user · verify argon2id · check lockout
    A->>DB: store hashed refresh token (12 h)
    A-->>W: {access 15 min, refresh, user}
    Note over W: access token expires during shift
    W->>A: POST /auth/refresh {refreshToken}
    A->>DB: validate + revoke old, issue rotated pair
    A-->>W: {new access, new refresh}
    Note over W,A: 5 failed logins → 423 locked 15 min<br/>+ audit event auth.lockout (US-01)
```
