# CLAUDE.md — portal-amef-staff (v2)

> **Acest fișier este citit de Claude Code CLI la fiecare sesiune.**
> Conține contextul curent al aplicației, convențiile de cod, regulile de testare și starea curentă a construcției.
> Locație: `C:\Aplicatii-Dianex\portal-amef\portal-amef-staff\CLAUDE.md`

---

## Application identity

| Attribute | Value |
|-----------|-------|
| **Name** | portal-amef-staff |
| **Type** | Backend Express + Frontend React (PWA) |
| **Repo** | dianex/portal-amef-staff |
| **Local folder** | C:\Aplicatii-Dianex\portal-amef\portal-amef-staff\ |
| **Local port** | 3001 |
| **Production domain** | amef.dianex.ro (TBD) |
| **Staging domain** | amef-staging.dianex.ro or Cloud Run URL (TBD) |
| **GCP project** | portal-amef |
| **Cloud SQL instance** | portal-amef (PostgreSQL 18, europe-west1) |

---

## Stack (FIXED — do not negotiate)

### Backend
- Node.js LTS 20+
- **JavaScript pure** (NO TypeScript)
- **CommonJS** (`require` / `module.exports`, NO `import` / `export`)
- Express
- `pg` direct (NO ORM, NO Prisma, NO Drizzle, NO Sequelize)
- Manual numbered SQL migrations (`001_*.sql`, `002_*.sql`)
- Zod for validation
- Pino + pino-http for logging (NO `console.log`)
- Helmet, cors, express-rate-limit
- **Vitest** + **Supertest** + **Bruno** for testing
- pnpm package manager

### Frontend
- React 18+ with Vite
- Tailwind CSS
- **JavaScript pure** (NO TypeScript)
- Functional components + Hooks
- **Vitest** + **React Testing Library** for testing

### Auth
- Firebase Identity Platform (Google SSO + email/password + 2FA TOTP mandatory)
- Custom JWT with claims `tenant_slug`, `role`, `firebase_uid`

### Database architecture (Model C)
- DB-per-tenant on shared instance
- Database for Dianex tenant: `amef_tenant_dianex` (production), `amef_tenant_dianex_staging` (staging)
- Database for shared data: `amef_shared` (production), `amef_shared_staging` (staging)
- Schema in tenant DB: `amef`
- Schema in shared DB: `amef_shared`
- Dedicated PostgreSQL user per tenant
- Connection strings in Secret Manager (`tenant-{slug}-db-connection`, `shared-db-connection`)

### Deploy
- Cloud Run europe-west1
- Two environments: `staging` and `production`
- CI: GitHub Actions with **mandatory tests gating**
- CD: Cloud Build with triggers on tags

---

## TESTING RULES (MANDATORY)

**A function/endpoint is NOT considered done until it has tests.**

### Required tests per component

| Component | Required test | Tool |
|-----------|---------------|------|
| Service function (`*-service.js`) | Unit test | Vitest |
| API endpoint (route + controller) | Integration test | Supertest |
| Zod schema | Unit test (valid + invalid input) | Vitest |
| Middleware (auth, requireRole, etc.) | Unit test | Vitest |
| React component | Render + interaction test | Vitest + React Testing Library |
| API endpoint (manual exploration) | Bruno request | Bruno |

### Coverage targets (enforced via vitest.config.js)

| Code type | Minimum coverage |
|-----------|-----------------|
| Services (business logic) | **80%+** |
| Controllers/routes | **70%+** |
| Middleware (auth, validate) | **100%** |
| Frontend components (critical) | **70%+** |

### Mandatory workflow per function

```
1. Write the code
2. Write the tests (Vitest unit + Supertest integration)
3. Save Bruno request (if endpoint)
4. Run `pnpm test` → all green
5. Run `pnpm test:coverage` → targets met
6. Commit with conventional message
```

**NEVER commit without green tests. CI in GitHub Actions blocks merge if tests fail or coverage drops below targets.**

### Test file naming

- Unit tests: `<filename>.test.js`
  - Example: `client-service.test.js`, `auth-middleware.test.js`
- Integration tests: `<route-name>.integration.test.js`
  - Example: `clients-route.integration.test.js`, `auth-route.integration.test.js`
- Tests live next to the code they test (collocated):
  ```
  src/services/
  ├── client-service.js
  ├── client-service.test.js
  ├── invoice-service.js
  └── invoice-service.test.js
  ```

### Vitest test pattern (CommonJS)

```javascript
// File: services/client-service.test.js

const { describe, it, expect, beforeEach, vi } = require('vitest');
const { createClient } = require('./client-service');
const { getTenantPool } = require('../db/pool');

// Mock external dependencies for test isolation
vi.mock('../db/pool', () => ({
  getTenantPool: vi.fn(),
}));

describe('client-service', () => {
  describe('createClient', () => {
    let mockPool;

    beforeEach(() => {
      // Reset mocks before each test
      mockPool = { query: vi.fn() };
      getTenantPool.mockResolvedValue(mockPool);
    });

    it('creează un client cu date valide', async () => {
      // Arrange
      const tenantSlug = 'dianex';
      const data = { cui: 'RO12345678', company_name: 'Test SRL' };
      mockPool.query.mockResolvedValue({
        rows: [{ id: 1, ...data }],
      });

      // Act
      const result = await createClient(tenantSlug, data);

      // Assert
      expect(result.id).toBe(1);
      expect(mockPool.query).toHaveBeenCalledTimes(1);
    });

    it('respinge CUI invalid (sub 2 caractere)', async () => {
      const data = { cui: 'X', company_name: 'Test SRL' };
      await expect(createClient('dianex', data)).rejects.toThrow();
    });

    it('respinge company_name gol', async () => {
      const data = { cui: 'RO12345678', company_name: '' };
      await expect(createClient('dianex', data)).rejects.toThrow();
    });
  });
});
```

### Supertest integration test pattern

```javascript
// File: routes/clients.integration.test.js

const { describe, it, expect, beforeAll } = require('vitest');
const request = require('supertest');
const { createApp } = require('../app');
const { generateTestJwt } = require('../tests/fixtures/auth');

describe('POST /api/v1/clients', () => {
  let app;
  let validJwt;

  beforeAll(async () => {
    app = createApp();
    validJwt = await generateTestJwt({
      tenant_slug: 'dianex_test',
      role: 'tenant_admin',
    });
  });

  it('creează client cu auth valid și date corecte', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${validJwt}`)
      .send({ cui: 'RO12345678', company_name: 'Test SRL' });

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
  });

  it('respinge request fără auth → 401', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .send({ cui: 'RO12345678', company_name: 'Test SRL' });

    expect(response.status).toBe(401);
  });

  it('respinge JWT invalid → 401', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', 'Bearer invalid-jwt')
      .send({ cui: 'RO12345678', company_name: 'Test SRL' });

    expect(response.status).toBe(401);
  });

  it('respinge date invalide → 400', async () => {
    const response = await request(app)
      .post('/api/v1/clients')
      .set('Authorization', `Bearer ${validJwt}`)
      .send({ cui: 'X', company_name: '' });

    expect(response.status).toBe(400);
    expect(response.body.success).toBe(false);
  });
});
```

### Vitest config with coverage gating

```javascript
// File: server/vitest.config.js

module.exports = {
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json', 'lcov'],
      thresholds: {
        // Per-folder thresholds (PER CLAUDE.md)
        'src/services/**': {
          lines: 80,
          functions: 80,
          branches: 70,
          statements: 80,
        },
        'src/middleware/**': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100,
        },
        'src/routes/**': {
          lines: 70,
          functions: 70,
          branches: 60,
          statements: 70,
        },
      },
    },
  },
};
```

### CI gating in GitHub Actions

```yaml
# .github/workflows/ci.yml
name: CI

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - run: pnpm install
      - run: pnpm lint
      - run: pnpm test                   # FAIL = block merge
      - run: pnpm test:coverage          # Coverage below threshold = block merge
```

---

## Folder structure

```
portal-amef-staff/
├── server/
│   ├── src/
│   │   ├── routes/
│   │   ├── controllers/
│   │   ├── services/             ← code + .test.js collocated
│   │   ├── db/
│   │   │   ├── pool.js
│   │   │   ├── pool.test.js
│   │   │   ├── migrate.js
│   │   │   ├── migrate.test.js
│   │   │   ├── migrations/
│   │   │   │   ├── shared/
│   │   │   │   └── tenant/
│   │   │   └── setup/
│   │   ├── middleware/           ← code + .test.js collocated
│   │   ├── utils/
│   │   ├── logger.js
│   │   ├── config.js
│   │   └── app.js
│   ├── tests/
│   │   ├── integration/          ← integration tests (Supertest)
│   │   └── fixtures/             ← test helpers, mock data, JWT generators
│   └── vitest.config.js
├── frontend/
│   ├── src/
│   │   ├── components/           ← .jsx + .test.jsx collocated
│   │   ├── pages/
│   │   ├── hooks/
│   │   └── utils/
│   ├── tests/
│   └── vitest.config.js
├── bruno/
│   └── portal-amef-staff/        ← Bruno API collection
├── docs/
├── Dockerfile
├── .env.example
├── .gitignore
├── .dockerignore
├── .husky/
│   └── pre-commit                ← runs `pnpm test && pnpm lint`
├── .github/
│   └── workflows/
│       └── ci.yml                ← CI with test gating
├── package.json
├── pnpm-workspace.yaml
├── README.md
└── CLAUDE.md                     ← this file
```

---

## Code conventions (MANDATORY)

### Filenames
- **kebab-case** mandatory: `client-service.js`, `auth-middleware.js`, `pool.js`
- **Test files:** `.test.js` (unit), `.integration.test.js` (integration)
- NO camelCase: `clientService.js` ❌
- NO PascalCase: `ClientService.js` ❌

### Functions and variables
- **camelCase** for functions and variables: `getClientByCui`, `tenantSlug`
- **UPPER_SNAKE_CASE** for constants: `MAX_RETRY_COUNT`, `JWT_EXPIRY_HOURS`
- **PascalCase** for classes (rare): `ErpAdapter`, `NexusErpAdapter`

### Module pattern (CommonJS)

```javascript
const { z } = require('zod');
const { getTenantPool } = require('../db/pool');
const logger = require('../logger');

const CreateClientSchema = z.object({
  cui: z.string().min(2).max(20),
  company_name: z.string().min(1).max(255),
});

async function createClient(tenantSlug, data) {
  const validated = CreateClientSchema.parse(data);
  const pool = await getTenantPool(tenantSlug);

  const result = await pool.query(
    `INSERT INTO amef.core_clients (cui, company_name, created_at)
     VALUES ($1, $2, NOW())
     RETURNING *`,
    [validated.cui, validated.company_name]
  );

  logger.info({ tenantSlug, clientId: result.rows[0].id }, 'Client created');
  return result.rows[0];
}

module.exports = {
  createClient,
};
```

### Error handling
- Throw errors via centralized middleware (NO try-catch in every route)
- Custom error classes: `ValidationError`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError`, `ConflictError` — în `server/src/errors/index.js`. Toate moștenesc `AppError` (Error + `statusCode` + `code` + `details?`).
- Convenție de flow: serviciile/route-urile **aruncă** erorile custom (sau lasă Zod/`ZodError` să curgă din `.parse()`); middleware-ul `server/src/middleware/error-handler.js` e singurul loc care formatează răspunsuri HTTP. NU faceți `res.status(...).json(...)` în route-uri pentru erori — rupe consistența și trebuie întreținut în multe locuri.
- Format răspuns standard: `{ success: false, error: <mesaj uman>, code: <CONST_CODE>, details?: ... }`. Frontend-ul face logică pe `code` (nu pe mesaj — care poate fi tradus).
- Erori HTTP din middleware-uri externe (body-parser `PayloadTooLargeError`, etc.) sunt detectate prin `err.statusCode` 4xx și expuse direct; 5xx-urile cad pe ramura generic-INTERNAL_ERROR. În production NU expunem `err.message`/`err.stack` pentru erori generice (poate conține detalii din DB).

### API responses
```javascript
// Success
{ "success": true, "data": { ... } }

// Error
{ "success": false, "error": "Human message", "code": "ERROR_CODE" }
```

### Code comments
- Comments in Romanian
- Explain **WHY**, not just **WHAT**
- Good: `// Cache pool per tenant pentru a evita re-creare conexiuni la fiecare request`
- Bad: `// Map cu pools` (superficial)

### Testing seam pattern (`_deps` injection)

Modules that depend on external resources we cannot easily replace at test time
(GCP clients, `pg.Pool`, filesystem readers, network clients) export a mutable
`_deps` object as the standard testing seam in this CJS project. Tests mutate
entries on `_deps` to inject mocks; production code must not touch `_deps`
directly except for the lazy initialisation that reads its members.

**Why this pattern:** Vitest's `vi.mock` does NOT intercept CommonJS `require()`,
and `vi.resetModules()` does not clear Node's native CJS require cache. Every
other approach (auto-mock factories, `vi.doMock`, `vi.hoisted` + factory)
proved either flaky or coupled to Vitest hoisting magic that does not apply to
CJS source files. Explicit injection via `_deps` is verbose but deterministic.

**Examples in the codebase:**
- `server/src/utils/secret-manager.js` — `_deps.ClientClass` (GCP Secret
  Manager client). Tests assign a constructor returning `{ accessSecretVersion: vi.fn() }`.
- `server/src/db/pool.js` — `_deps.PoolClass`, `_deps.getSecret`, `_deps.logger`.
  Tests assign a fake Pool factory and a noop logger.
- `server/src/db/migrate.js` — `_deps.fs` (filesystem), `_deps.logger`.
  Tests assign a fake `readdirSync` to control which migration files are visible.

**Module template:**

```javascript
const realDep = require('some-package');
const realLogger = require('../logger');

// _deps object exported strictly for testing. Tests mutate _deps.client/_deps.logger
// to inject mocks. Production code MUST NOT touch _deps directly except in lazy init.
const _deps = {
  client: realDep,
  logger: realLogger,
};

async function doWork() {
  // Production reads from _deps so test injections are picked up automatically.
  const result = await _deps.client.fetch();
  _deps.logger.info({ result }, 'Done');
  return result;
}

module.exports = { doWork, _deps };
```

**Test template:**

```javascript
const mod = require('./my-module');

beforeEach(() => {
  mod._deps.client = { fetch: vi.fn().mockResolvedValue('mocked') };
  mod._deps.logger = { info: vi.fn(), error: vi.fn() };
});
```

Caveat: do not enumerate `_deps` keys in production code. Treat them as
read-only references during normal execution.

---

## Secret naming convention

Numele secretelor din GCP Secret Manager sunt derivate prin convenție din
`utils/secret-naming.js` (`deriveSecretName(kind, env, slug)`). NU le hardcodați
în `.env` și NU le construiți inline — `pool.js` și `migrate-cli.js` consumă
helper-ul ca să avem un singur loc de modificat când regula se schimbă (ex:
adăugare variantă `preview` pentru deploy-uri PR).

| kind   | env        | secret name                              |
|--------|------------|------------------------------------------|
| shared | production | `shared-db-connection`                   |
| shared | staging    | `shared-staging-db-connection`           |
| tenant | production | `tenant-<slug>-db-connection`            |
| tenant | staging    | `tenant-<slug>-staging-db-connection`    |

Regula slug: `/^[a-z0-9-]+$/` (litere mici, cifre, cratimă). `kind` ∈
{shared, tenant}, `env` ∈ {production, staging}; orice alt input aruncă.

**Mapping NODE_ENV → env** (`envFromNodeEnv` în același modul):
- `production` → `production`
- `staging` → `staging`
- `development` → `staging` (dev local atinge DB-ul de staging; nu vrem să
  provisonăm o a treia DB pentru dev fără date reale)
- orice alt NODE_ENV → `staging` (default safe — nu cădem accidental pe
  production)

`pool.js` derivă automat env-ul din `config.NODE_ENV`. `migrate-cli.js`
acceptă `--env production|staging` explicit (default production) ca admin-ul
să poată ținti staging și de pe o mașină cu `NODE_ENV=production`.

---

## Database conventions

- Schema per app: `amef` (NOT `public`)
- Tables prefixed: `core_*` (clients, cash_registers, documents), `staff_*` (invoices, payments, declarations), `erp_*` (sync_log, sync_queue)
- PK: `id SERIAL PRIMARY KEY`
- Timestamps: `created_at TIMESTAMPTZ DEFAULT NOW()`, `updated_at TIMESTAMPTZ DEFAULT NOW()`
- Soft delete: `deleted_at TIMESTAMPTZ NULL`
- FK explicit with `ON DELETE CASCADE` or `SET NULL`
- Indexes on WHERE/JOIN/FK columns
- Direct SQL via `pg`, no ORM
- Migrations: NU pun `SET search_path TO ...` la început; folosesc nume
  fully-qualified (`amef.core_clients`, `amef_shared.tenants`). Runner-ul
  (`migrate.js`) tracking-uiește `schema_migrations` cu schema explicită,
  iar FQN-urile sunt imune la migrațiile-utilizator care ar muta
  search_path-ul mid-session.

---
## Tenant DB schema overview

Schema `amef` din DB-urile de tenant (`amef_tenant_<slug>` în production,
`amef_tenant_<slug>_staging` în staging). Tabelele se adaugă pe stage-uri;
mai jos e starea curentă.

### Tabele existente

| Tabela                            | Rol | Stage adăugat |
|-----------------------------------|-----|---------------|
| `amef.core_representative_roles`  | Lookup pentru rolul reprezentantului legal al unui client (administrator, asociat, PFA, titular CMI, etc.) — populată cu 6 seed-uri la migrare. Editabilă din Dashboard Configurare Tenant (Stage 12). | 5a (mig 001) |
| `amef.core_clients`               | Clienții tenantului (SRL/PFA/ÎI cu CUI sau persoane fizice cu CNP). Vezi structura detaliată mai jos. | 5a (mig 001 + 002) |
| `amef.schema_migrations`          | Tracking automat al migrațiilor aplicate (creată de `migrate.js`, NU de o migrație SQL). | 2 |

### `core_clients` — detalii structură

**Identificare fiscală:**
- `fiscal_code_type` ∈ {`CUI`, `CNP`} (CHECK constraint).
- `fiscal_code` — NOT NULL. Toți clienții au identificare fiscală.
- UNIQUE pe `(fiscal_code, deleted_at)` cu `NULLS NOT DISTINCT` — un fiscal_code activ unic per tenant.

**Adresă companie** (toate NOT NULL, populate din ANAF la creare):
- `county`, `city`, `street`, `street_number`. Plus `address_full` (text liber), `address_extra`, `postal_code` opționale.

**Contact:**
- `phone`, `email` — ambele opționale individual.
- CHECK `phone_or_email_required`: cel puțin unul dintre `phone` și `email` trebuie să fie NOT NULL.
- `email` UNIQUE per tenant (partial unique index: `WHERE email IS NOT NULL AND deleted_at IS NULL`) — rezervă unicitatea pentru clienți activi cu email, permite multipli clienți fără email să coexiste. Folosit ca login pentru portalul Client (Faza B).
- `notes` (TEXT) pentru contacte adiționale și observații staff.

**Reprezentant legal** (toate nullable după migrația 002 — datele legacy din Drive pot fi incomplete; service layer-ul Stage 5b enforce-ază prezența la creare via UI cu Zod):
- `representative_name`, `representative_role_id` (FK → `core_representative_roles`).
- CI: `representative_ci_series`, `representative_ci_number`, `representative_ci_issued_by`, `representative_ci_issued_at`.
- Adresă reprezentant: `representative_county`, `representative_city`, `representative_street`, `representative_street_number`, `representative_address_full`, `representative_address_extra`, `representative_postal_code`.

**Banking:** `iban`, `bank_name` (ambele opționale).

**Status ANAF:**
- `is_vat_payer` (boolean, default false).
- `anaf_verified` (boolean, default false), `anaf_verified_at`, `anaf_status`.
- `anaf_data` (JSONB) — cache complet al răspunsului ANAF webservice. Două motivații: (a) graceful fallback când ANAF API e down, avem date locale + timestamp ultima verificare; (b) cron zilnic de re-verificare compară JSON-ul nou cu cel cached și flag-uiește schimbări.

**Audit:** `created_at`, `updated_at`, `deleted_at` (soft-delete), `created_by_id`.

### Indexuri pe `core_clients`

- `core_clients_pkey` — PK btree pe `id`.
- `fiscal_code_unique_active` — UNIQUE btree pe `(fiscal_code, deleted_at) NULLS NOT DISTINCT`.
- `idx_core_clients_email_unique_active` — UNIQUE btree pe `email`, partial `WHERE email IS NOT NULL AND deleted_at IS NULL`.
- `idx_core_clients_email` — btree non-unique pe `email`, partial `WHERE email IS NOT NULL` (lookup cross-tenant audit, inclusiv soft-deleted).
- `idx_core_clients_fiscal_code` — btree non-unique pe `fiscal_code` (lookup direct).
- `idx_core_clients_company_name_trgm` — **GIN trigram** pe `company_name` cu `gin_trgm_ops` (search ILIKE `'%fragment%'` în UI). Necesită extension `pg_trgm`.
- `idx_core_clients_anaf_pending` — btree pe `anaf_verified`, partial `WHERE anaf_verified = false` (cron de re-verificare scanează doar nepreverificați).
- `idx_core_clients_recent_active` — btree pe `(created_at DESC)`, partial `WHERE deleted_at IS NULL` (lista paginată "ultimii clienți").

### Extensions PostgreSQL

- `pg_trgm` 1.6+ — necesar pentru GIN trigram pe `company_name`. Activat în migrația 002.

### Migrații aplicate

| # | Filename | Descriere | Aplicat staging | Aplicat production |
|---|----------|-----------|-----------------|---------------------|
| 001 | `001_init_tenant_schema.sql` | Schema inițială: `core_representative_roles` (cu seed) + `core_clients` (companie NOT NULL, reprezentant NOT NULL la momentul scrierii) + indexuri inițiale + UNIQUE constraints. | 2026-05-05 | 2026-05-05 |
| 002 | `002_relax_representative_and_add_anaf_cache.sql` | Forward fix post-divergență: DROP NOT NULL pe 9 coloane `representative_*` (Drive legacy), ADD `anaf_data` JSONB, ADD CHECK `phone_or_email_required`, înlocuire btree `idx_core_clients_company_name` cu GIN trigram, înlocuire `idx_core_clients_active` (predicat tautologic) cu `idx_core_clients_recent_active` (utility query "ultimii clienți"). Pattern `NOT VALID + VALIDATE` pentru CHECK. | 2026-05-05 | 2026-05-05 |

Tabelele care vin în stage-urile următoare (articole, facturi, plăți, case de marcat, dosar tehnic, declarații fiscale, audit log) se adaugă prin migrații `003+`.

---

## Auth flow (Stage 4)

**Decizie D6 (MVP, revizuită 2026-05-05):** Google SSO ONLY via Firebase
Identity Platform. Email/parolă și Microsoft SSO sunt amânate până când
avem un tenant care nu e Google Workspace.

**2FA e responsabilitatea TENANT-ului**, enforcing-ul se face prin **Google
Workspace policy** (admin.google.com → Security → 2-Step Verification →
Enforce). Backend-ul NU verifică suplimentar claim-ul Firebase MFA —
Google a validat deja factorul al doilea înainte de a emite ID token-ul, iar
Firebase MFA peste asta ar duplica fără câștig real de securitate (în plus,
Firebase MFA e feature plătit Identity Platform, iar UX-ul popup-ului dublu
e net inferior). E pattern-ul standard SaaS B2B 2026 (Salesforce / Asana /
Linear). Tenant_admin-ul e cel care trebuie să forțeze 2FA în Google
Workspace — backend-ul îl ia ca dat.

**Fluxul end-to-end:**
1. Frontend: utilizatorul apasă „Login cu Google" → Firebase Web SDK
   declanșează popup-ul Google Sign-In (Google validează 2FA dacă e
   configurat pe cont).
2. Firebase emite un `idToken` (JWT semnat de Google) către frontend.
3. Frontend face `POST /api/v1/auth/firebase-login { idToken }`.
4. Backend (`auth-service.validateFirebaseToken`):
   - Verifică `idToken` cu firebase-admin (semnătură + expirare).
   - Acceptă orice token valid emis de Firebase prin Google provider.
     2FA NU e verificat la nivel de backend (vezi D6 revizuit mai sus).
5. Backend (`resolveTenantUser`): caută `firebase_uid` în
   `amef_shared.tenant_users JOIN amef_shared.tenants`. Dacă lipsește /
   `is_active = false` / `deleted_at` setat → 403.
6. Backend (`emitJwt` + `emitRefreshToken`): semnează JWT-uri proprii
   (HS256, secret din Secret Manager) cu claim-uri:
   `sub` (firebase_uid), `email`, `tenant_slug`, `tenant_id`, `role`,
   `type` (access|refresh), `jti`, `iat`, `exp`.
7. Frontend stochează JWT-ul (memorie pentru access, httpOnly cookie sau
   secure storage pentru refresh — Stage 4 Part B decide).
8. Pentru toate request-urile autenticate ulterioare, frontend trimite
   `Authorization: Bearer <jwt>`. Middleware-ul `authMiddleware` validează
   și populează `req.user`.
9. La expirarea access-token-ului, frontend face `POST /api/v1/auth/refresh
   { refreshToken }`; backend rotește perechea (emite atât access cât și
   refresh nou) — astfel rolul curent e re-citit din DB la fiecare refresh.

**Endpoint-uri:**
- `POST /api/v1/auth/firebase-login` — public.
- `POST /api/v1/auth/refresh` — public.
- `POST /api/v1/auth/logout` — autentificat (audit-trail; MVP nu
  invalidează token-urile server-side, durata scurtă a access-token-ului
  limitează expunerea).

**Frontend (Stage 4 Part B):**
- `frontend/src/firebase.js` — inițializează Firebase Web SDK din
  `import.meta.env.VITE_FIREBASE_*`. Provider Google cu
  `setCustomParameters({ prompt: 'select_account' })` pentru ergonomie când
  user-ul are mai multe conturi Google în browser.
- `frontend/src/utils/api-client.js` — axios instance cu request interceptor
  (Bearer header) și response interceptor (refresh-on-401 cu deduplicare
  in-flight). Pe eșec de refresh: clear localStorage + redirect `/login`.
  Storage keys: `amef.jwt`, `amef.refresh`, `amef.user`.
- `frontend/src/contexts/AuthContext.jsx` — `<AuthProvider>` la root, expune
  `useAuth()` cu `{ user, loading, isAuthenticated, login, logout }`. La
  mount restaurează user-ul din localStorage; `login(idToken)` POST-ează la
  backend și persistă tokens; `logout()` notifică backend (best-effort) +
  signOut Firebase + clear local state.
- `frontend/src/components/ProtectedRoute.jsx` — wrapper pentru rute
  autenticate. `loading` → spinner; `!user` → `<Navigate to="/login" replace />`;
  user prezent → randează children. Folosit în `App.jsx` pentru `/`.
- `frontend/src/pages/LoginPage.jsx` — card centrat cu un singur buton
  „Continuă cu Google" (signInWithPopup). Erorile sunt afișate în roșu;
  mesajele specifice sunt extrase din `err.response.data.error` (axios) sau
  `err.code` (Firebase: `auth/popup-closed-by-user`, `auth/popup-blocked`).
  Auto-redirect la `/` dacă user-ul e deja autentificat la mount.
- `frontend/src/pages/HomePage.jsx` — placeholder cu greeting + rol +
  tenant_slug + buton Logout. Conținutul real (clienți, facturi) vine
  începând cu Stage 5.

---

## Roles in Portal AMEF

3 roles total:

| Role | Who | Access |
|------|-----|--------|
| `tenant_admin` | Owner + 1-2 backups | All functions + Dashboard Configurare Tenant |
| `tenant_user` | Other employees | All daily functions (no Dashboard Configurare) |
| `platform_operator` | Dianex staff | Cross-tenant access for support |

Rules:
- **Individual account per employee** (NOT shared)
- **2FA mandatory** (TOTP)
- **Dashboard Configurare Tenant** routes under `/api/v1/admin/*` with `requireRole(['tenant_admin'])` middleware
- Frontend: "Configurare Tenant" menu **completely invisible** for `tenant_user` (NOT just disabled)

---

## Useful commands

### Local development
```bash
# Start backend (port 3001)
cd server
pnpm dev

# Start frontend (port 5173)
cd frontend
pnpm dev

# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Run tests with coverage
pnpm test:coverage

# Run a specific test file
pnpm test client-service

# Run only integration tests
pnpm test:integration

# Lint
pnpm lint
pnpm lint:fix
```

### Database
```bash
# Connect to Cloud SQL via Auth Proxy
cloud-sql-proxy.exe portal-amef:europe-west1:portal-amef --port 5432

# Connect to staging shared DB
psql "postgresql://app_shared_staging:PASSWORD@127.0.0.1:5432/amef_shared_staging"

# Connect to production tenant DB
psql "postgresql://tenant_dianex_app:PASSWORD@127.0.0.1:5432/amef_tenant_dianex"

# Run migrations
pnpm migrate:shared              # apply migrations to amef_shared
pnpm migrate:tenant -- dianex    # apply migrations to amef_tenant_dianex
pnpm migrate:all                 # all DBs
```

### Deploy
```bash
# Deploy staging (auto on push to develop, after CI passes)
git push origin develop

# Deploy production (auto on tag)
git tag v1.0.0
git push origin v1.0.0
```

### Bruno API testing
```bash
# Run Bruno collection
bru run bruno/portal-amef-staff
```

---

## Environment variables

See `.env.example` for the complete list. Critical ones:

```
# Server
NODE_ENV=development|staging|production
PORT=3001
LOG_LEVEL=info

# Auth
JWT_SECRET_NAME=jwt-secret-{env}
JWT_EXPIRY_HOURS=1
REFRESH_TOKEN_EXPIRY_DAYS=7
FIREBASE_PROJECT_ID=portal-amef|portal-amef-staging

# Database
# (Numele secretelor sunt derivate prin convenție din NODE_ENV — vezi
#  „Secret naming convention" mai sus.)
GCP_PROJECT_ID=portal-amef

# CORS
CORS_ORIGIN=http://localhost:5173

# External services
ANAF_API_BASE_URL=https://webservicesp.anaf.ro
ERP_SYNC_SERVICE_URL=https://portal-amef-erp-sync-{hash}-ew.a.run.app
ANAF_SIGNER_DEFAULT_TIMEOUT_MS=30000

# Storage
GCS_BUCKET_PREFIX=portal-amef-docs

# Email
SENDGRID_API_KEY_SECRET_NAME=sendgrid-api-key-{env}
EMAIL_FROM_ADDRESS=portal@dianex.ro

# Test environment
TEST_DB_CONNECTION_STRING=postgresql://...  # for integration tests against staging
```

---

## DO NOT (strict rules)

When working on this codebase, NEVER do these things:

1. **NEVER** use TypeScript
2. **NEVER** use ORM (Prisma, Drizzle, Sequelize, Knex)
3. **NEVER** use ES modules (`import` / `export`) — use CommonJS
4. **NEVER** use `console.log` in production code — use Pino logger
5. **NEVER** suggest non-GCP services (NO AWS, NO Vercel, NO Supabase)
6. **NEVER** create a simple `clients` table — use `amef.core_clients`
7. **NEVER** use schema `public` — always use schema `amef` (or `amef_shared` for shared DB)
8. **NEVER** hardcode database credentials — read from Secret Manager
9. **NEVER** mix English and Romanian in code comments — Romanian only
10. **NEVER** skip Zod validation on user input
11. **NEVER** deploy to production without going through staging first
12. **NEVER** put real Dianex client data in staging DB (use seed data or anonymized subset)
13. **NEVER** write a function/endpoint without writing its tests immediately after
14. **NEVER** commit if `pnpm test` fails or coverage drops below targets
15. **NEVER** skip the Bruno request for new endpoints

---

## Build progress (current state)

> **This section is updated after each completed stage.**

**Current stage:** Sub-stage 5e — Frontend Modulul Clienți. 4 rute (`/clients`, `/clients/new`, `/clients/:id`, `/clients/:id/edit`), 3 hooks (useClients/useClient/useAnafLookup), 6 componente (3 pagini + ClientForm + AnafLookupBadge + ClientStaleBanner), utils (clients-api + clients-validation Zod simplificat). 47 teste noi frontend (95 total). Coverage `src/pages/**` 95.35/84.53/86.95, `src/components/**` 97.13/73.4/93.33, `src/hooks/**` 96.61/85.71/100, `src/utils/**` 96.11/88.31/89.28. Code complete, NOT committed.

**Last completed stage:** Sub-stage 5d — Clients routes + Bruno + integration tests (6 endpoint-uri + middleware ANAF rate-limit + 17 integration tests + 6 Bruno requests; merged pe main).

**Next action:** Stage 6 — Integration with erp-sync (after merge Stage 5).

### Completed stages

- [x] Stage 1 — Setup project and structure (incl. testing infrastructure)
- [x] Stage 2 — Setup databases and migration runner (with tests)
- [x] Stage 3 — Express app bootstrap (merged)
- [x] Stage 4 — Login and Tenant Resolution (Part A backend + Part B frontend, merged)
- [~] Stage 5 — Clients module with ANAF auto-completion
  - [x] 5a — DB schema (migrations 001 + 002 applied to staging + production, merged pe main)
  - [x] 5b — Service layer (`client-service.js` 9 funcții + 3 scheme Zod + PG error mapping; 54 unit tests; merged pe main)
  - [x] 5c — ANAF lookup service (`anaf-lookup-service.js` cu retry + cache 24h + stale fallback; `judete-romania.js` helper; 35 teste; merged pe main)
  - [~] 5d — Routes `/api/v1/clients` (6 endpoint-uri) + ANAF rate-limiter + integration tests + Bruno collection (code complete, NOT committed)
  - [~] 5e — Frontend (4 rute + 3 hooks + ClientForm + ClientsListPage + ClientDetailsPage + 47 teste; code complete, NOT committed)
- [ ] Stage 6 — Integration with erp-sync (with tests)
- [ ] Stage 7 — Articles + Invoicing module (with full test suite)
- [ ] Stage 8 — Cash registers + Technical dossier (with tests)
- [ ] Stage 9 — Integration with anaf-signer (with tests)
- [ ] Stage 10 — Fiscal flow module C801 + F4102 (with tests + real critical test)
- [ ] Stage 11 — Documents + DOCX generator (with tests)
- [ ] Stage 12 — Audit log + Dashboard Configurare Tenant (with full test suite)
- [ ] Stage 13 — Drive migration Dianex (with tests + real migration)
- [ ] Stage 14 — End-to-end testing + Bug fixing (regression tests)
- [ ] Stage 15 — Production deploy + Monitoring (CI gating)

### Current test status
> _Update after each test run._

```
Last `pnpm test` run: 2026-05-06 (Sub-stage 5e complete) — server: 371 passed + 36 integration skipped
  (no local Postgres), frontend: 95 passed (was 48 — net +47 noi în 5e)
Last `pnpm test:coverage` run: 2026-05-05 — server stats per file (stmt/branch/func/lines):
  - src/app.js:               100 / 100 / 100 / 100
  - src/config.js:            100 / 93.33 / 100 / 100
  - src/logger.js:            100 / 100 / 100 / 100
  - src/db/migrate.js:        100 / 100 / 100 / 100
  - src/db/pool.js:           99.34 / 100 / 83.33 / 99.34
  - src/errors/index.js:      100 / 100 / 100 / 100
  - src/middleware/auth-middleware.js:    100 / 100 / 100 / 100
  - src/middleware/error-handler.js:      100 / 100 / 100 / 100  (threshold 100%)
  - src/middleware/not-found-handler.js:  100 / 100 / 100 / 100
  - src/middleware/require-role.js:       100 / 100 / 100 / 100
  - src/routes/auth.js:       100 / 100 / 100 / 100
  - src/routes/health.js:     96.66 / 87.5 / 100 / 96.66       (threshold 70% — passes)
  - src/services/auth-service.js: 100 / 90 / 100 / 100         (threshold 80% — passes)
  - src/utils/secret-manager.js:  100 / 100 / 100 / 100
  - src/utils/secret-naming.js:   100 / 100 / 100 / 100
  - src/db/migrate-cli.js + src/server.js: excluded from coverage (entry points)
Frontend stats per file (stmt/branch/func/lines):
  - src/App.jsx:                          100 / 100 / 100 / 100
  - src/components/ProtectedRoute.jsx:    100 / 100 / 100 / 100
  - src/contexts/AuthContext.jsx:         100 / 100 / 100 / 100
  - src/pages/LoginPage.jsx:              100 / 89.47 / 100 / 100
  - src/pages/HomePage.jsx:               100 / 100 / 100 / 100
  - src/utils/api-client.js:              100 / 97.22 / 92.3 / 100
  - src/firebase.js + src/main.jsx: excluded from coverage (entry / config-only modules)
Integration tests against real Postgres run automatically in CI (postgres:18 service container).
Locally, `pnpm test:integration` requires `TEST_DB_CONNECTION_STRING` to be set.
```

### How to run tests

```bash
# All workspaces, run mode (no watch) — folosit în CI și pre-commit
pnpm test                    # = pnpm -r test:run
pnpm -r test:run

# Watch mode local
pnpm test:watch              # = pnpm -r test:watch

# Coverage cu praguri din vitest.config.js
pnpm test:coverage           # = pnpm -r test:coverage

# Doar server / doar frontend
pnpm --filter @portal-amef-staff/server test:run
pnpm --filter @portal-amef-staff/frontend test:run

# Doar integration tests pe server
pnpm --filter @portal-amef-staff/server test:integration

# Un singur fișier
pnpm --filter @portal-amef-staff/server test:run -- src/services/client-service.test.js
```

CI rulează `pnpm -r lint`, `pnpm -r test:run`, `pnpm -r test:coverage` la fiecare push pe `main`/`develop` și pe PR. Husky `.husky/pre-commit` rulează aceleași comenzi local — commit-ul este blocat dacă oricare eșuează.

### Notes from build

**Stage 1 (2026-05-05):**
- pnpm workspace cu 2 pachete: `server` (`@portal-amef-staff/server`) și `frontend` (`@portal-amef-staff/frontend`); `packageManager: pnpm@10.33.0` în root pentru CI determinist
- Backend: Express, pg, Zod, Pino + pino-http, Helmet, cors, express-rate-limit, jsonwebtoken, firebase-admin, @google-cloud/secret-manager, dotenv. Dev: vitest 2.1 + @vitest/coverage-v8, supertest, eslint, prettier, pino-pretty
- Frontend: React 18 + Vite 5 + Tailwind 3 (postcss + autoprefixer). Config Vite cu proxy `/api` → `http://localhost:3001` pentru dev fără CORS
- Build scripts approved în `pnpm.onlyBuiltDependencies` din root `package.json`: `esbuild`, `protobufjs` (necesare pentru Vite și firebase-admin)
- `.gitkeep` pentru a păstra în git folderele goale ale structurii
- `app.js`, `config.js`, `logger.js` apar la Stage 3 conform planului

**Stage 4 follow-up: MFA verification relaxed (2026-05-05, NOT committed):**
- Eliminat verificarea claim-ului `firebase.sign_in_second_factor` /
  `mfa_verified` din `auth-service.validateFirebaseToken`. Motiv: a respins
  userii Dianex legitimi care au 2FA pe contul Google (YubiKey) — token-ul
  Firebase emis prin Google provider nu propagă claim-ul de second factor
  decât dacă MFA e enrollat în Firebase Identity Platform (un feature plătit).
- Decizie nouă: backend-ul are încredere în autentificarea Google. 2FA e
  responsabilitatea tenant-ului — `tenant_admin`-ul forțează 2FA prin
  Google Workspace admin policy. Documentat în D6 revizuit (vezi „Auth
  flow"). Pattern standard SaaS B2B 2026 (Salesforce / Asana / Linear).
- Cod: `validateFirebaseToken` returnează acum orice token valid emis de
  firebase-admin; helper-ul `hasMfa` și `ForbiddenError`-ul aferent au fost
  șterse. `ForbiddenError` rămâne folosit în `resolveTenantUser` (user
  inactiv / șters / neînregistrat în tenant_users). Restul flow-ului
  neschimbat — frontend continuă să afișeze 403 pentru cazurile reale de
  ForbiddenError (cont neautorizat).

**Sub-stage 5e — Frontend Modulul Clienți (2026-05-06, code complete, NOT committed):**
- **Rute noi în `App.jsx`** (decizia 1a — separate routes per action, nu modal/single SPA route):
  - `/clients` → `ClientsListPage`
  - `/clients/new` → `ClientFormPage mode="create"`
  - `/clients/:id` → `ClientDetailsPage`
  - `/clients/:id/edit` → `ClientFormPage mode="edit"`
  Toate wrap-uite în `<ProtectedRoute>` (Stage 4). Catch-all `*` rămâne neschimbat.
- **Hooks (3 noi în `src/hooks/`):**
  - `useClients({ limit, offset, search, fiscalCodeType, anafVerified })` — list paginat. AbortController + serializare filtre via `JSON.stringify` ca dependency-key (un obiect nou la fiecare render ar declanșa refetch infinit). La schimbare filtre abort-ăm request-ul în zbor — request-ul vechi venind după cel nou ar suprascrie state-ul. Întoarce `{ data, loading, error, refetch }`.
  - `useClient(id)` — single client. Pattern identic + dacă `id` e null/undefined NU face fetch (folosit la mode='create' al ClientFormPage).
  - `useAnafLookup()` — manual trigger only (decizia 3b — buton, NU pe blur). Întoarce `{ lookup, reset, loading, result, error }`. NU fetch automat la mount; lookup() apelează `/lookup-by-cui` și setează result + propagă erorile prin throw.
- **Componente (3 noi în `src/components/`):**
  - `AnafLookupBadge` — badge cu 4 stări (verified/stale/never/error). Pragul de stale = 30 zile peste `anaf_verified_at`. Tailwind colored dots + text.
  - `ClientStaleBanner` — banner galben (decizia 4a) afișat când `lookup` întoarce `stale: true`. Dismissible (X local state — nu persistă).
  - `ClientForm` — form-ul propriu-zis, ~470 linii. 5 secțiuni `<fieldset>` (Identificare fiscală / Date companie / Contact / Reprezentant legal / Banking). În mode='edit' fiscal_code_type și fiscal_code sunt read-only (DB nu permite update). Buton „Verifică ANAF" lângă fiscal_code (vizibil doar pe CUI, NU pe CNP) declanșează auto-completare company_name + adresă + flag is_vat_payer; pe stale=true randează ClientStaleBanner la top. Submit: `safeParse` Zod, mesaje inline per câmp via `zodErrorsToFieldMap`.
- **Pagini (3 noi în `src/pages/`):**
  - `ClientsListPage` — tabel paginat cu filtre (search ILIKE pe denumire, fiscalCodeType, anafVerified). PAGE_SIZE = 20. Click pe rând → navigate la detalii; butoanele Edit/Șterge per rând (Șterge doar pentru `tenant_admin`, decizia 4b). Empty state, loading state, error state cu retry.
  - `ClientFormPage` — wrapper care delegă la ClientForm. În edit mode fetchează clientul prin useClient și hidratează formul. La submit success: `navigate('/clients/:id', { replace: true })`. Erorile backend (409 FISCAL_CODE_DUPLICATE etc.) afișate ca formError top-of-form (decizia: NU per câmp pentru că DB nu spune cu siguranță care câmp a creat conflictul).
  - `ClientDetailsPage` — read-only view cu tab-uri. Tab-ul „General" listează toate câmpurile în 5 secțiuni mirror cu form-ul; tab-urile „Parc case" (Stage 8) și „Documente" (Stage 11) sunt placeholder-uri.
- **Utils (3 noi în `src/utils/`):**
  - `clients-api.js` — wrapper-uri thin peste `api-client.js` (`get`/`post`/`put`/`del`): 6 funcții (`listClients`, `getClientById`, `createClient`, `updateClient`, `deleteClient`, `lookupCui`). `buildQueryString` omite undefined/null/'' dar PĂSTRAEZĂ boolean false (filtru valid „neverificați"). Toate acceptă `signal` opțional pentru cancellation.
  - `clients-validation.js` (decizia 5b) — Zod schemas frontend simplificat. Backend rămâne autoritate finală (service-ul 5b face validare strictă cu PG error mapping). Frontend dublează DOAR câmpurile + regex-uri identice cu cele din `client-service.js` (CUI/CNP/IBAN/date) ca să prindă greșeli evidente fără round-trip. `CreateClientFormSchema` strict + `UpdateClientFormSchema = .omit({ fiscal_code_type, fiscal_code }).partial()` (immutabile post-creare). Helper `zodErrorsToFieldMap` + `BACKEND_ERROR_MESSAGES` map (8 coduri backend → mesaje user-friendly).
  - `representative-roles.js` — hardcoded array cu 6 valori (oglindă cu seed-ul migrației 001). TODO Stage 12: înlocuit cu fetch dinamic la `GET /api/v1/admin/representative-roles` când endpoint-ul va exista.
- **Decizii aplicate**: 1a (separate routes), 2b (custom hook + AbortController, NU TanStack Query), 3b (manual ANAF button, NU pe blur), 4a (yellow stale banner), 4b (Șterge doar pentru tenant_admin), 5b (separate frontend Zod simplificat).
- **Dependența nouă: `zod@^3.25.76`** (frontend) — necesară pentru clients-validation. Versiune identică cu cea din pnpm store (folosită deja de server). Singura dependență nouă; `react-hook-form`, `TanStack Query`, `@hookform/resolvers/zod` NU au fost adăugate (decizia 5b — `safeParse` direct cu controlled inputs e suficient pentru un form de această dimensiune).
- **Test counts (47 noi frontend)**:
  - `src/utils/clients-api.test.js` — 10 tests (query string building, get/post/put/del wrappers, lookup body, error propagation).
  - `src/utils/api-client.test.js` — 17 tests (NESCHIMBATE, Stage 4).
  - `src/hooks/useClients.test.js` — 7 tests (initial state, success, error, refetch on filter change, refetch() function, unmount abort, abort vs success race).
  - `src/hooks/useAnafLookup.test.js` — 5 tests (idle, success, stale=true, error 404, reset).
  - `src/components/ClientForm.test.jsx` — 6 tests (5 sections, phone XOR email, ANAF lookup call, ANAF auto-fill, ANAF stale banner, Anulează).
  - `src/pages/ClientsListPage.test.jsx` — 9 tests (title + button, loading, empty, table render, search refetch, filter selects, row click, admin delete, tenant_user fără Șterge).
  - `src/pages/ClientFormPage.test.jsx` — 5 tests (create empty, create submit success, Zod inline error, 409 backend error, edit pre-fill + readonly).
  - `src/pages/ClientDetailsPage.test.jsx` — 5 tests (loading, general tab data, Parc case tab, Documente tab, error + Înapoi la listă).
  - Total frontend: 95 (de la 48 înainte de 5e — net +47).
- **Coverage frontend (toate țintele 70%+ atinse):**
  - `src/components/`: 97.13/73.4/93.33/97.13 (AnafLookupBadge 100/62.5, ClientForm 96.9/75.67, ClientStaleBanner 95.12/33.33, ProtectedRoute 100/100).
  - `src/hooks/`: 96.61/85.71/100/96.61 (useAnafLookup 100, useClient 89.28, useClients 100).
  - `src/pages/`: 95.35/84.53/86.95/95.35 (ClientDetailsPage 99.28, ClientFormPage 88.33, ClientsListPage 91.48 funcs/80%, HomePage 100, LoginPage 100).
  - `src/utils/`: 96.11/88.31/89.28/96.11 (api-client 100/94.59, clients-api 100/100, clients-validation 91.83/71.42, representative-roles 100/66.66).
- **Hardcoded representative_roles (TODO Stage 12)**: 6 valori în `representative-roles.js` — Administrator, Asociat unic, PFA - titular, ÎI - titular, Director General, Reprezentant împuternicit. Exact aceleași seed-uri din migrația `001_init_tenant_schema.sql`. Stage 12 va înlocui cu fetch dinamic la `GET /api/v1/admin/representative-roles`.
- **Lecții**:
  - **AbortController în React StrictMode**: dependency-key serializat (`JSON.stringify(filters)`) PREVINE refetch-uri infinite când caller-ul construiește un obiect nou de filtre la fiecare render. Alternative (useDeepCompareEffect) sunt overkill pentru filtre flat.
  - **Testing Library labels cu asterisk**: când randăm `<span>Label<span> *</span></span>`, textul normalizat în label devine `Label *` (cu spațiu înainte de asterisk). Regex-ul `/^Label$/i` NU match-uie; trebuie `/^Label \*$/i` sau folosit `getByRole('textbox', { name: ... })`.
  - **`del()` din api-client NU acceptă body** — doar `(url, config)`. Dacă viitor un endpoint DELETE va cere body (rar, dar posibil), va trebui adăugat third arg. Pentru moment soft-delete-ul nu trimite body.
  - **Decizia mode prop vs URL parsing**: `ClientFormPage` primește `mode` ca prop din `App.jsx` în loc să-l deducă din URL (`useMatch` sau `pathname.endsWith('/edit')`). Mai explicit și permite re-utilizare pentru rute cu schemă diferită (ex: `/clients/:id/duplicate` în viitor).

**Sub-stage 5d — Clients routes + Bruno + integration tests (2026-05-06, code complete, NOT committed):**
- `server/src/routes/clients.js` (~250 linii) — 6 endpoint-uri sub `/api/v1/clients`:
  - `GET /` — listare paginată (limit, offset, search, fiscalCodeType, anafVerified) + rolurile `tenant_admin`/`tenant_user`.
  - `GET /:id` — detalii client; 404 dacă lipsește SAU e soft-deleted.
  - `POST /` — creare via UI; service-ul (5b) face Zod-ul pe body, route-ul doar verifică shape obiect.
  - `PUT /:id` — update parțial.
  - `DELETE /:id` — soft-delete; **doar `tenant_admin`** (decizia 4b). Răspunde cu `{ id, deleted_at }`.
  - `POST /lookup-by-cui` — auto-completare ANAF cu cache 24h + fallback stale; rate-limit 30/h/user prin `anafRateLimit`.
- **Validare la nivel de rută** (Zod): `IdParamSchema` pentru path, `ListClientsQuerySchema` pentru query (cu `z.coerce` pentru limit/offset, preprocess explicit pentru `anafVerified` ca să distingă `'false'`/`'true'` strings de defaultul `true`-pe-orice-non-empty al `z.coerce.boolean()`), `LookupCuiBodySchema` pentru lookup-by-cui (`cui` ca string|integer, `referenceDate` regex YYYY-MM-DD). Body-ul POST/PUT NU e re-validat la rută — service-ul are deja schemele complete și aruncă `ZodError` care e formatat de error-handler-ul central. Route-ul doar verifică ca body-ul să fie obiect non-null, non-array (defensive — `Object.keys(undefined)` ar arunca în service).
- **Mount în `app.js`**: `app.use('/api/v1/clients', clientsRouter)` — înainte de placeholder-ul `/api/v1` ca să prindă rutele specifice. authMiddleware aplicat pe ÎNTREGUL router (`router.use`), `requireRole(['tenant_admin'])` doar pe DELETE, `requireRole(['tenant_admin', 'tenant_user'])` pe rest.
- **`server/src/middleware/anaf-rate-limit.js`** (~70 linii) — rate-limiter dedicat pentru `/lookup-by-cui`. 30 cereri/oră/user (NOT per IP — `keyGenerator` întoarce `${tenantSlug}:${firebaseUid}`). De ce dedicat: ANAF poate suspenda integrarea la volume mari, iar rate-limit-ul global pe `/api` e per-IP (un birou cu 5 useri ar împărți cota globală). Factory `buildAnafRateLimit({ max, windowMs })` exportat pentru testare cu fereastră scurtă (testele setează `max: 3` ca să atingă 429 în 4 cereri în loc de 31).
- **JWT claim `user_id` adăugat** (modificare auth Stage 4): `auth-service.emitJwt` primește acum `userId` ca parametru și-l include în payload-ul JWT (`user_id` claim); `auth-middleware` îl populează pe `req.user.id`. Motivație: `POST /clients` trebuie să seteze `created_by_id = tenant_users.id` în DB; fără claim, ar fi nevoie de un DB hit per request pentru a-l extrage. Schimbarea e backward-compatible: tokenele vechi fără claim → `req.user.id` undefined → service aruncă natural când DB-ul respinge NULL pentru `created_by_id` (NOT NULL în schema).
- **`tests/integration/clients.integration.test.js`** (~360 linii) — 17 integration tests pe Postgres real (CI service container; skip local fără `TEST_DB_CONNECTION_STRING`):
  - Setup: `applyMigrations` pentru ambele dirs (shared + tenant) într-o singură DB Postgres; seed `amef_shared.tenants` + `amef_shared.tenant_users` cu un user de test cu id=1.
  - Mocks: `clientService._deps.getTenantPool` override la pool-ul de test; `anafLookupService._deps.httpClient` mock-uit pe per-test (testele NU lovesc ANAF real); `clientsRouter._deps.authMiddleware` înlocuit cu un fake care populează `req.user` direct (auth-ul real e deja integration-tested în `auth.integration.test.js`, NU duplicăm).
  - Cazuri: GET (3) — empty list, seeded clients, search filter; POST (4) — happy path, fiscal_code dup → 409, email dup → 409, phone+email lipsă → 400; GET/:id (2) — found, 404; PUT/:id (2) — partial update + DB reflectă, 404; DELETE/:id (3) — admin success, tenant_user → 403, deja șters → 404; lookup-by-cui (3) — happy mock, notFound mock, ANAF down → 503 (cu timeout mărit la 30s pentru retry-urile cu backoff).
- **Bruno collection** la `bruno/portal-amef-staff/` (creată din 0):
  - `bruno.json` — collection root.
  - `environments/local.bru` (`baseUrl: http://localhost:3001`) și `staging.bru` (`baseUrl: https://amef-staging.dianex.ro`); ambele cu placeholder `authToken` pe care utilizatorul îl populează manual cu un JWT din `/firebase-login`.
  - `clients/` — 6 fișiere `.bru`: `list-clients`, `get-client-by-id`, `create-client` (cu body realist complet), `update-client` (body parțial), `delete-client`, `lookup-by-cui`. Fiecare folosește `{{baseUrl}}` și `{{authToken}}` și are bloc `docs {}` cu detalii despre erorile posibile.
- **Test counts**:
  - `routes/clients.test.js` — 25 unit tests cu services mock-uite (5 GET list, 3 GET/:id, 5 POST, 3 PUT, 3 DELETE, 6 lookup).
  - `middleware/anaf-rate-limit.test.js` — 8 unit tests (defaults + 7 scenarii de comportament inclusiv branch coverage pentru fallback IP).
  - `tests/integration/clients.integration.test.js` — 17 integration tests (skip local).
  - Net Stage 5d: 33 unit + 17 integration = 50 noi teste.
  - Total server suite: 371 passed + 36 skipped (de la 369/19 înainte de 5d — net +2 unit pentru că am refactorizat anaf-rate-limit).
- **Coverage**:
  - `src/routes/clients.js`: 97.96% statements / 87.5% branches / 100% functions / 97.96% lines (ținta 70/60/70 — depășită). Liniile 232-237 neacoperite = bloc-ul de validare body shape pe PUT (acoperit de testul corespunzător din POST, dar PUT-ul are același cod duplicat — acceptabil pentru moment, candidat de DRY-up dacă apare un al treilea endpoint cu același pattern).
  - `src/middleware/anaf-rate-limit.js`: 100% peste tot (ținta 100%).
  - Toate celelalte module rămân la coverage anterior.
- **Lecție**: claim-urile JWT trebuie privite ca un contract stabil. Adăugarea unui câmp nou (`user_id`) e backward-compatible (tokenele vechi îl văd ca undefined și flow-ul cade natural pe NOT NULL în DB), DAR redenumirea sau eliminarea unui câmp ar invalida sesiunile active. Pentru schimbări destructive ar trebui versionate (`v: 2` în payload) sau coordonate cu un cycle de invalidare în Identity Platform.

**Sub-stage 5c — ANAF lookup service (2026-05-05, code complete, NOT committed):**
- `server/src/services/anaf-lookup-service.js` (~330 linii) — wrapper peste ANAF V9 webservice (`POST https://webservicesp.anaf.ro/api/PlatitorTvaRest/v9/tva`). Pattern-uri replicate din implementarea Dianex (factura.js — în uz în producție): payload ARRAY de obiecte `[{ cui, data }]` (V9 e batch-capable, dar noi trimitem mereu 1 element), header `Content-Type: application/json`, timeout 15s. Diferențe față de Dianex: Pino logger în loc de log.factura, validare răspuns cu Zod, cache in-memory cu TTL 24h, erori prin AppError subclasses.
- **Cache strategy** (option 2c — global cross-tenant, in-memory): `Map<cui:referenceDate, { data, cachedAt, referenceDate }>` la nivel de modul. Datele ANAF sunt publice, deci cache-ul cross-tenant e safe (un client cu același CUI la 2 tenanți primește același rezultat din cache). Cheia include `referenceDate` (`YYYY-MM-DD`) ca să distingă lookup-uri la date diferite (audit istoric). Pe restart Cloud Run cache-ul se pierde — primul lookup post-boot pentru un CUI = round-trip la ANAF (acceptabil pentru MVP; opțional Stage 12 mutăm în Memorystore Redis dacă scale-ul cere).
- **Stale fallback (3c)**: când ANAF eșuează după toate retry-urile, dacă avem ORICE entry în cache (chiar expirat) returnăm `{ ...entry.data, stale: true }` în loc să aruncăm. UI-ul afișează banner „Date învechite — ANAF temporar indisponibil". Fără cache deloc → `ServiceUnavailableError(ANAF_UNAVAILABLE)`. Decizia: o sesiune întreagă cu ANAF down nu trebuie să blocheze contabilul de la editare; poate continua cu date de ieri.
- **Retry strategy** (replică Dianex factura.js): `ANAF_MAX_RETRIES = 3`, backoff exponențial cu jitter `Math.pow(2, attempt) * 1000 + Math.random() * 1000` ms ca să de-sincronizeze instanțele Cloud Run dacă pornesc retry-uri simultan. `shouldRetry(err)` întoarce true pentru network errors (no `err.response`), 5xx și 429; bail-out imediat pe alte 4xx (e.g. 400 = payload broken — retry n-ar ajuta). Logger.warn pe fiecare retry, logger.error pe failure final.
- **Zod response validation** (`AnafV9ResponseSchema`): `.passthrough()` peste tot (`date_generale`, `inregistrare_scop_Tva`, `stare_inactiv`, `inregistrare_SplitTVA`, `adresa_sediu_social`, `adresa_domiciliu_fiscal`, top-level). Motivație: ANAF schimbă/adaugă câmpuri auxiliare între versiuni minore (deja am văzut `statusRO_e_Factura` apărut într-o versiune V9 fără anunț). Validăm DOAR câmpurile pe care le folosim (cui, denumire, scpTVA, statusInactivi, statusSplitTVA), restul tolerăm. Răspuns malformat → `ServiceUnavailableError(ANAF_RESPONSE_INVALID)` cu log error pentru triage.
- **CUI normalization** (`_normalizeCui`): acceptă integer (`1234567`), string fără prefix (`'1234567'`), string cu prefix RO și/sau spații (`'RO1234567'`, `'RO 1234567'`, `'ro1234567'`). Toate sunt convertite la string numeric pur care poate fi `parseInt`-uit pentru payload-ul ANAF (care cere CUI ca integer). Input nevalid (non-numeric, negativ, float) → `ValidationError(INVALID_CUI)`.
- **Error mapping** (5 coduri custom prin `setErrorCode` + mutație post-construcție, pattern din 5b):

| Caz | AppError | code custom |
|-----|----------|-------------|
| input nevalid → normalize fail | ValidationError | `INVALID_CUI` |
| ANAF răspunde notFound | NotFoundError | `CUI_NOT_FOUND_AT_ANAF` |
| răspuns shape invalid (Zod) | ServiceUnavailableError | `ANAF_RESPONSE_INVALID` |
| API down după retries, fără cache | ServiceUnavailableError | `ANAF_UNAVAILABLE` |
| API down DAR cache disponibil | (no throw) | returnează cu `stale: true` |

- **Helper extras: `server/src/utils/judete-romania.js`** — mapping bidirecțional între numele județelor (fără diacritice, ca în seed-ul `core_representative_roles`) și codurile auto de 2 litere (ISO 3166-2:RO + lista oficială ANAF). 41 județe + Municipiul București = 42 entries. Funcții: `normalizeJudetCod(input)` (acceptă fie numele fie codul, returnează codul) și `prettyJudetName(code)` (cod → nume; cod necunoscut → input ca-i, defensive). Folosit la convertirea răspunsului ANAF (`dcod_JudetAuto: 'B'` → `county: 'Bucuresti'`).
- **Bucharest sector extraction**: pentru județul `B` extragem „Sector N" din `ddenumire_Localitate` cu regex `/sector(?:ul)?\s*(\d)/i` — răspunsurile reale ANAF V9 conțin „BUCURESTI SECTORUL <N>", dar tolerăm și forma scurtă „SECTOR <N>" pentru robustețe.
- **`ServiceUnavailableError` (nou în `errors/index.js`)** — statusCode 503, default code `SERVICE_UNAVAILABLE`. Folosit pentru ANAF down și (viitor) orice altă dependință externă cu disponibilitate variabilă. 2 teste noi în `errors/index.test.js` (instance check + cod custom prin mutație).
- **Test seam `_deps`**: `httpClient` (default = wrapper peste `axios.post`), `logger`, `now` — toate injectabile. Testele NU folosesc `vi.mock` pe axios (consistent cu Stage 2a lesson în CLAUDE.md). Default httpClient e o funcție mică externalizată (linii 62-64 — neacoperite în coverage pentru că tests injectează mock-ul).
- **`axios` adăugat ca dependență server** — `pnpm add axios@^1.16.0` (același range ca frontend). Folosit doar pentru ANAF V9 acum; viitoarele integrări externe (anaf-signer Stage 9, erp-sync Stage 6) îl vor refolosi.
- **35 noi teste**:
  - `judete-romania.test.js` — 14 teste (3 pentru maps, 7 pentru `normalizeJudetCod`, 4 pentru `prettyJudetName`).
  - `anaf-lookup-service.test.js` — 27 teste organizate pe scenarii:
    - `_normalizeCui` (5): integer, RO prefix, case-insensitive, integer, invalid input.
    - `lookupByCui — happy path` (6): cache miss, cache hit, skipCache, referenceDate diferit, Date object, fără referenceDate.
    - `lookupByCui — notFound` (2): NotFoundError, NU caching.
    - `lookupByCui — retry` (5): 500 → success, network → success, 3× 5xx fără cache → ServiceUnavailable, fallback la stale cache, 4xx no retry.
    - `lookupByCui — răspuns malformat` (3): lipsește found, denumire missing, found+notFound goale.
    - `cache management` (3): stocare cu cachedAt, expirare la 24h, _clearCache().
    - `mapping adresa non-București` (3): Cluj cu localitate normală, judet cod necunoscut → empty, adresa lipsă complet → câmpuri goale.
  - `errors/index.test.js` — 2 teste noi pentru ServiceUnavailableError + 1 update la „toate moștenesc Error" (acum 6 instances).
- **Coverage:**
  - `anaf-lookup-service.js`: 99.31% statements / 91.2% branches / 88.88% functions / 99.31% lines (ținta 80/70/80/80 — depășită). Liniile 62-64 neacoperite = `defaultHttpClient` (neexecutat pentru că testele injectează mock direct pe `_deps.httpClient`).
  - `judete-romania.js`: 100% peste tot.
  - `errors/index.js`: 100% peste tot (păstrat).
- **Test duration**: ~12 secunde pe `anaf-lookup-service.test.js` din cauza retry-urilor cu setTimeout real (4 teste × backoff exponențial). Acceptabil pentru CI; dacă devine problemă, mutăm `sleep` în `_deps` pentru testing rapid.
- Total server suite: 338 passed + 19 skipped (de la 295 înainte de 5c — net +43 noi: +35 din 5c + 1 update +7 reorganizate).
- **Out of scope (confirmare):** rute Express (5d), integrare frontend (5e), cron de re-verificare zilnic (deferat la Stage 12), persistență cache în DB (decision: option 2c — in-memory only).

**Sub-stage 5b — Service layer Modulul Clienți (2026-05-05, code complete, NOT committed):**
- `server/src/services/client-service.js` (~480 linii) — 9 funcții publice:
  - `createClientFromUi(tenantSlug, createdByUserId, data)` — validare strictă (representative_* required); INSERT; ConflictError pe duplicate fiscal_code/email.
  - `createClientFromImport(tenantSlug, createdByUserId, data)` — validare relaxată (representative_* optional, .partial()); pentru migrarea Drive Stage 13.
  - `getClientById(tenantSlug, id)` — `WHERE id = $1 AND deleted_at IS NULL`; NotFoundError dacă lipsește SAU e soft-deleted (UI nu trebuie să distingă).
  - `findClientByFiscalCode(tenantSlug, fiscalCode)` / `findClientByEmail` — return row sau null (NU aruncă); folosit la duplicate-check înainte de creare în UI.
  - `listClients(tenantSlug, { limit, offset, search, fiscalCodeType, anafVerified })` — paginare + 3 filtre opționale; WHERE construit dinamic cu placeholder-i `$1, $2, ...` count-ați incremental; ORDER BY created_at DESC (folosește `idx_core_clients_recent_active`); `search` face ILIKE `'%fragment%'` pe company_name (folosește GIN trigram); 2 query-uri (count + page) — `COUNT(*) OVER ()` ar dubla costul la limit=1000+.
  - `updateClient(tenantSlug, id, data)` — partial update; SET dinamic doar pe câmpurile prezente în data + `updated_at = NOW()` literal; `WHERE id = $X AND deleted_at IS NULL`; NotFoundError dacă 0 rows; PG erori bubble-up via `runQuery`. No-op (data gol) → fall-through la getClientById.
  - `softDeleteClient(tenantSlug, id)` — `SET deleted_at = NOW() WHERE id = $1 AND deleted_at IS NULL`; mesajul include „nu există SAU e deja șters" (UI nu trebuie să le distingă).
  - `restoreClient(tenantSlug, id)` — 2 query-uri: SELECT pentru a distinge 404 (id inexistent) vs 409 (deja activ); apoi UPDATE clear deleted_at. Nu folosesc un singur UPDATE deoarece `WHERE id = $1 AND deleted_at IS NOT NULL` cu 0 rows nu permite distincția între cele două cazuri.
- **Compoziție scheme Zod cu `.merge()`** — single source of truth pentru fiecare câmp. Helpere ZodObject pure (mergeable), refines cross-field aplicate la nivel compus:
  - `FiscalSchema` — fiscal_code_type enum + fiscal_code; refine custom (`refineFiscalCode`) verifică regex CUI `/^(RO\s?)?\d{2,10}$/i` SAU CNP `/^\d{13}$/` în funcție de tip.
  - `CompanyAddressSchema` — county/city/street/street_number required + address_full/extra/postal_code optional.
  - `ContactSchema` — phone + email ambele optional individual; refine `refinePhoneOrEmail` la composed level (cel puțin unul prezent).
  - `RepresentativeFullSchema` (UI mode) vs `RepresentativePartialSchema = .partial()` (Import mode). Câmpurile auto-optional în UI: `representative_ci_series`, `representative_address_full`, `representative_address_extra`, `representative_postal_code` — ele rămân optional și în UI.
  - `BankingSchema` — IBAN regex `/^RO\d{2}[A-Z]{4}\d{16}$/i` (case-insensitive).
  - `AnafStatusSchema` — `is_vat_payer.default(false)`, `anaf_verified.default(false)`, `anaf_data: z.unknown()` (JSONB acceptă orice — validarea structurii vine în 5c când avem clientul ANAF).
  - `CommonClientFields` — company_name + notes.
  - Compoziție: `FiscalSchema.merge(...).merge(...).superRefine(refineFiscalCode).superRefine(refinePhoneOrEmail)` pentru Create. Pentru Update: same minus FiscalSchema (fiscal_code și fiscal_code_type nu sunt updateable) + `.partial()`. Refine-ul phone||email NU se aplică la Update — DB CHECK enforce-ează pe row-ul final.
- **Maparea PG erori → AppError** — `mapPgError(err)` discriminează pe `err.code` SQLSTATE + `err.constraint`:

| SQLSTATE | constraint | AppError | code custom |
|----------|------------|----------|-------------|
| 23505 | `fiscal_code_unique_active` | ConflictError | `FISCAL_CODE_DUPLICATE` |
| 23505 | `idx_core_clients_email_unique_active` | ConflictError | `EMAIL_DUPLICATE` |
| 23514 | `phone_or_email_required` | ValidationError | `PHONE_OR_EMAIL_REQUIRED` |
| 23514 | `core_clients_fiscal_code_type_check` | ValidationError | `INVALID_FISCAL_CODE_TYPE` |
| 23503 | `core_clients_representative_role_id_fkey` | ValidationError | `REPRESENTATIVE_ROLE_INVALID` |
| altele | — | re-throw original | (cade pe INTERNAL_ERROR) |

Codul custom (ex: `FISCAL_CODE_DUPLICATE`) e setat pe instanță via `setErrorCode(err, code)` (mutație post-construcție) — clasele din `errors/` au coduri default fixe; mutația permite codarea precisă fără a sparge contractul claselor existente. Helper-ul `runQuery(pool, sql, params)` wrap-uie pool.query și aruncă rezultatul lui mapPgError.
- **`INSERT_COLUMNS`** — array constant cu 34 coloane setabile din service (toate non-managed). INSERT-ul folosește acest array ca single source of truth: `INSERT INTO ... (cols) VALUES ($1, ..., $N) RETURNING *`. Câmpurile lipsă din `data` devin NULL (mapate explicit în `values.map`). `is_vat_payer` și `anaf_verified` au `.default(false)` în Zod, deci după parse vor fi mereu boolean.
- **Test seam `_deps`** — `_deps.getTenantPool` și `_deps.logger` injectabile pentru teste. Pool-ul mock în teste e `{ query: vi.fn() }` cu `mockResolvedValueOnce`/`mockRejectedValueOnce` per call (listClients și restoreClient fac 2 query-uri).
- **54 unit tests** în `client-service.test.js`:
  - `createClientFromUi` — 15 cazuri (3 success cu phone/email/ambele, 9 Zod rejections, 2 DB unique conflicts).
  - `createClientFromImport` — 5 cazuri (3 success inclusiv full-blank representative, 2 Zod company_name/county still required).
  - `getClientById` / `findClientByFiscalCode` / `findClientByEmail` — câte 3 cazuri (success + not found + soft-deleted; find-urile întorc null vs throw).
  - `listClients` — 7 cazuri (default paginare, custom limit/offset, search, fiscalCodeType, anafVerified, combinație, empty).
  - `updateClient` — 5 cazuri (partial single, multiple fields, NotFound, ConflictError pe email, ZodError pe email invalid).
  - `softDeleteClient` / `restoreClient` — câte 3 cazuri (success + 2 căi de eroare; restoreClient distinge 404 vs 409).
  - `_mapPgError` — 7 cazuri direct testing pentru ramurile rămase (23514 phone_or_email, 23514 fiscal_code_type, 23503 FK rep_role, unknown SQLSTATE re-throw, unknown constraint pe 23505/23514, null/undefined defensive).
- **Coverage `client-service.js`:** 99.63% statements / 96.92% branches / 100% functions / 99.63% lines (ținta CLAUDE.md `src/services/**`: 80/70/80/80 — depășită cu margin). Liniile neacoperite (452-453) sunt fall-through-ul „no-op update" (data gol) — defensive, neexpus prin route-uri normale.
- Total server suite: 295 passed + 19 skipped (de la 241 înainte de 5b — net +54 noi).

**Sub-stage 5a — DB schema Modulul Clienți (2026-05-05, applied to staging + production, pending PR/merge):**
- `migrations/tenant/001_init_tenant_schema.sql` — înlocuit placeholder Stage 2 (`CREATE SCHEMA amef`) cu schema reală: `core_representative_roles` (lookup cu 6 seed-uri: Administrator, Asociat unic, PFA - titular, ÎI - titular, Director General, Reprezentant împuternicit) + `core_clients` (37 coloane: identificare fiscală CUI/CNP, adresă companie completă, contact, reprezentant legal complet cu CI și adresă, banking, status ANAF, notes, audit). UNIQUE constraints: `(fiscal_code, deleted_at) NULLS NOT DISTINCT` (un fiscal_code activ unic per tenant). Partial unique index: `email WHERE email IS NOT NULL AND deleted_at IS NULL` — permite multipli clienți fără email să coexiste, dar enforce unicitate pe cei cu email (prep pentru login portal Client Faza B). Indexuri inițiale: btree pe `fiscal_code`, `email` (partial), `company_name` (btree simplu — corectat în 002), `(deleted_at) WHERE deleted_at IS NULL` (corectat în 002), `anaf_verified WHERE = false`. FK `representative_role_id → core_representative_roles(id)`.
- `migrations/tenant/002_relax_representative_and_add_anaf_cache.sql` — forward fix după aplicarea 001 pe staging și descoperirea divergențelor:
  - **9× ALTER COLUMN ... DROP NOT NULL** pe coloanele `representative_*` (`representative_name`, `representative_role_id`, `representative_ci_*`, `representative_county/city/street/street_number`). Decizia 2c: companie NOT NULL (date din ANAF garantate), reprezentant nullable (Drive legacy migration Stage 13 va avea date incomplete). Service layer-ul (5b) enforce-ază prezența la creare via UI cu Zod.
  - **ADD COLUMN `anaf_data JSONB`** — cache complet răspuns ANAF webservice. Două use-cases: graceful fallback când ANAF API e down + cron zilnic de re-verificare comparând JSON-uri.
  - **ADD CONSTRAINT `phone_or_email_required` CHECK (phone IS NOT NULL OR email IS NOT NULL)** cu pattern `NOT VALID` + `VALIDATE CONSTRAINT` separat (best practice production cu date — evită lock ACCESS EXCLUSIVE pe table scan). Pe staging tabela e goală, pe production aplicat înainte de orice INSERT, ambele paths fără overhead.
  - **CREATE EXTENSION pg_trgm** + înlocuire btree `idx_core_clients_company_name` cu GIN `(company_name gin_trgm_ops)` — btree-ul susține doar lookup exact și prefix; pentru search ILIKE `'%fragment%'` din UI e necesar trigram. Trade-off: ~10-20% mai lent la INSERT, dar tabela e read-heavy.
  - **DROP `idx_core_clients_active`** (btree pe `deleted_at WHERE deleted_at IS NULL` — predicat tautologic, planner nu-l folosește) **+ CREATE `idx_core_clients_recent_active`** pe `(created_at DESC) WHERE deleted_at IS NULL` (susține "lista paginată ultimii clienți" + ORDER BY DESC).
- **Decizii arhitecturale Stage 5a:**
  - **Tipuri entități:** SRL/PFA/ÎI cu CUI + persoane fizice cu CNP (`fiscal_code_type` CHECK).
  - **ANAF down:** fallback graceful + cron zilnic + buton manual re-verificare (cache în `anaf_data`).
  - **CUI duplicat:** 409 + link spre client existent (UNIQUE constraint enforce-ează).
  - **Adresa:** `address_full` (text liber editabil) + 4 câmpuri structurate (county/city/street/street_number) + `address_extra` + `postal_code`.
  - **Contacte:** 1 phone + 1 email + `notes` (TEXT pentru contacte adiționale).
  - **Email UNIQUE per tenant:** doar pentru clienți activi cu email (partial index).
  - **Telefon SAU email obligatoriu:** CHECK constraint la nivel DB (defense-in-depth) + Zod la nivel service.
  - **`representative_role_id`:** tabel separat (`core_representative_roles`) editabil din Dashboard Configurare Tenant Stage 12.
- **Aplicare migrații:**
  - Staging: tracking 001 (din Stage 2 placeholder) DELETE-uit manual → re-apply 001 + apply 002 → schema finală 3 tabele (`core_clients`, `core_representative_roles`, `schema_migrations`), 6 roluri seed, 2 entries în tracking.
  - Production: identic — DELETE 001 placeholder → apply 001 + 002 within same `migrate-cli.js` run (`Applied: 2 | Skipped: 0`).
  - Validare schemă: `\d amef.core_clients` confirmă 37 coloane, 8 indexuri, 2 CHECK constraints, 1 FK.
- **Lecție migrațiilor:** runner-ul tracking-uiește **filename**, nu hash conținut. Modificarea unui fișier deja aplicat NU declanșează re-rulare. Pe production NICIODATĂ nu modificăm un fișier de migrație deja aplicat — corecturile vin întotdeauna ca migrații noi cu numere incrementale (forward-only). Pe staging am făcut excepție DOAR pentru 001 (era placeholder gol din Stage 2) — pattern care nu se repetă pe production cu date reale.
- **Lecție DB schema:** UNIQUE NULLS NOT DISTINCT collapse-uiește toate NULL-urile într-o singură "valoare egală" — util când NULL e o stare ilegală (ex: `fiscal_code` care nu poate fi NULL legal). Pentru cazuri unde NULL e legitim (ex: `email` la clienți persoană fizică) folosim partial unique index `WHERE column IS NOT NULL` care permite multipli NULL să coexiste.

**Stage 4 Part B — Frontend auth (Google SSO popup + JWT storage + protected routes) (2026-05-05, code complete, NOT committed):**
- Dependențe noi (frontend): `firebase` (Web SDK v12), `react-router-dom` (v7), `axios` (v1). `pnpm install` rulează clean (un warning de build-script pentru `@firebase/util` — irrelevant pentru runtime).
- `frontend/src/firebase.js` — initializeApp + getAuth + GoogleAuthProvider; toate config-urile vin din `import.meta.env.VITE_*` (Vite expune doar variabilele cu prefix VITE_ la browser, by design). `setCustomParameters({ prompt: 'select_account' })` ca user-ul să aleagă explicit contul. Modulul e exclus din coverage (wrapper de inițializare, fără logică de testat unitar — testele consumatorilor îl mock-uiesc complet).
- `frontend/src/utils/api-client.js` — axios cu request interceptor (Bearer din `localStorage[amef.jwt]`) și response interceptor (refresh-on-401 cu deduplicare in-flight ca să nu lansăm 5 refresh-uri paralele când 5 cereri eșuează simultan). Test seam `_deps.redirect` ca să spy-uim redirect-ul în jsdom (`window.location.assign` e non-configurable). Storage keys: `amef.jwt`, `amef.refresh`, `amef.user`. 17 unit tests acoperă request/response interceptors, deduplicarea refresh-ului, eșecul de refresh (clear + redirect), wrapper-ele get/post/put/del.
- `frontend/src/contexts/AuthContext.jsx` — `<AuthProvider>` cu state `{user, loading}`. `login(idToken)` apelează backend-ul prin api-client și persistă tokens; `logout()` e best-effort la backend (audit), apoi signOut Firebase + clear local. `useAuth()` aruncă dacă e folosit fără provider. Test seam `_deps.signOut` ca testele să nu atingă Firebase. 11 tests.
- `frontend/src/components/ProtectedRoute.jsx` — gate pentru rute autenticate cu trei stări: spinner (loading=true), `<Navigate to="/login" replace />` (!user), children (user prezent). 3 tests.
- `frontend/src/pages/LoginPage.jsx` — card Tailwind centrat, buton „Continuă cu Google" cu logo SVG inline. Erorile sunt clasificate: 403 cu mesaj backend (2FA / cont neautorizat), `auth/popup-closed-by-user`, `auth/popup-blocked`, fallback. State `signingIn` → buton disabled + text „Se conectează...". Auto-redirect `/` dacă user-ul e deja autentificat. 10 tests.
- `frontend/src/pages/HomePage.jsx` — placeholder cu email + tenant + rol + buton Logout. 4 tests.
- `frontend/src/App.jsx` — `<AuthProvider>` la root, `<Routes>` cu `/login` și `/` (protected), catch-all `*` → `/`. `BrowserRouter` rămâne în `main.jsx` ca testele să folosească `<MemoryRouter>` direct. 3 tests pentru routing (user neautentificat → redirect la login pe orice rută).
- `frontend/vitest.config.js` actualizat: praguri 70%/60%/70% pe `src/components`, `src/hooks`, `src/pages`, `src/contexts`, `src/utils` (extinse pentru Stage 4B); `src/firebase.js` exclus din coverage.
- 48 unit tests passed local pe frontend (de la 0). Toate țintele de coverage atinse: components/contexts/pages/utils la 95%+ pe orice metric.

**Stage 4 Part A — Backend auth (Google SSO + own JWT) (2026-05-05, code complete, NOT committed):**
- Decizie **D6 update**: Google SSO ONLY pentru MVP. Email/parolă și Microsoft SSO sunt amânate până când avem un tenant non-Workspace. 2FA delegat lui Google. **Notă (revizuit 2026-05-05):** verificarea Firebase MFA suplimentară a fost relaxată după ce a respins userii Dianex legitimi cu YubiKey pe contul Google — backend-ul acceptă acum orice token Firebase valid; tenant_admin-ul forțează 2FA prin Google Workspace policy. Vezi nota „Stage 4 follow-up: MFA verification relaxed" mai jos și D6 revizuit în secțiunea „Auth flow".
- `src/services/auth-service.js`: `validateFirebaseToken`, `emitJwt`, `emitRefreshToken`, `verifyJwt`, `resolveTenantUser`. Inițializare lazy a `firebase-admin` din service account JSON (citit din Secret Manager). JWT-uri proprii HS256 cu claim-uri: `sub`/`email`/`tenant_slug`/`tenant_id`/`role`/`type`/`jti`. `_deps` injectabil pentru `verifyIdToken`/`getSecret`/`pool`/`logger` în teste — toate I/O mock-uite la nivel unitar; JWT-urile reale sunt semnate/verificate end-to-end (jsonwebtoken).
- `src/middleware/auth-middleware.js`: citește `Authorization: Bearer <jwt>`, refuză orice tip ≠ `access` (refresh-token-urile NU pot fi folosite ca acces direct). Populează `req.user = { firebaseUid, email, tenantSlug, tenantId, role, jti }`.
- `src/middleware/require-role.js`: factory `requireRole(allowedRoles[])`. `req.user` lipsă → 401, rol nepermis → 403. Convenție: `platform_operator` NU primește implicit drepturile de `tenant_admin` — trebuie listat explicit dacă rute admin trebuie deschise lui.
- `src/routes/auth.js`: `POST /firebase-login`, `POST /refresh` (rotește ambele tokens; re-citește rolul din DB), `POST /logout` (auth-protected; MVP doar audit, fără revocare server-side). Body validat cu Zod; erorile cad pe error-handler-ul central.
- `src/app.js`: mount `/api/v1/auth` ÎNAINTE de placeholder-ul `/api/v1` (specificitatea route-urilor contează în Express).
- `src/config.js`: nou `FIREBASE_SERVICE_ACCOUNT_SECRET_NAME` (required string). `.env.example` actualizat.
- Integration tests în `tests/integration/auth.integration.test.js` (15 tests) — Postgres real (CI service container), Firebase mock-uit prin `_deps.verifyIdToken`. Skipate local fără `TEST_DB_CONNECTION_STRING`.
- 244 unit tests passed local (was 189; +55 net Stage 4a). Toate țintele de coverage atinse (auth-service 100/90/100/100; auth-middleware 100/100/100/100; require-role 100/100/100/100; routes/auth 100/100/100/100).

**Stage 3 — Express app bootstrap (2026-05-05, code complete, NOT committed):**
- `src/errors/index.js` — `AppError` + 5 subclase (`ValidationError`/`UnauthorizedError`/`ForbiddenError`/`NotFoundError`/`ConflictError`); fiecare cu `statusCode`+`code` proprii și `details?` opțional.
- `src/middleware/error-handler.js` — middleware central de erori. Cascadă: `AppError` → `statusCode/code` din clasă; `ZodError` → 400 cu `details` listă de issues; eroare cu `err.statusCode` 4xx (body-parser etc.) → expusă direct; orice altceva → 500 cu `INTERNAL_ERROR` (mesaj + stack expuse doar în development). Loghează cu `_deps.logger` + `req.id` din pino-http.
- `src/middleware/not-found-handler.js` — un-liner care apelează `next(new NotFoundError(method + url))` ca middleware-ul central să formateze.
- `src/routes/health.js` — `GET /health` (200 cu uptime/timestamp) + `GET /health?check=db` (probe pe `amef_shared.tenants LIMIT 1`; returnează 503 + `DB_UNAVAILABLE` la eșec ca probe-urile Cloud Run să poată distinge alive vs ready).
- `src/app.js` — factory `createApp(options?)` care wire-uiește (în această ordine): `helmet` → `cors` (cu `CORS_ORIGIN` din config) → `pino-http` → `express.json({ limit: '1mb' })` → `rateLimit` (100/15min, **doar pe `/api/*`** ca probe-urile să bypass-eze) → `/health` router → placeholder `/api/v1` router (vine populat în Stage 4+) → `notFoundHandler` → `errorHandler`. `trust proxy: 1` pentru ca rate-limit să citească `X-Forwarded-For` corect pe Cloud Run.
- `src/server.js` — entry point: `dotenv.config()` → `require('./config')` (validează env, fail-fast) → `createApp().listen(PORT)` → handler SIGTERM care închide listener-ul + apelează `closeAllPools` cu timeout de 8s. Cloud Run dă ~10s la deploy/scaling. Exclus din coverage (bootstrap, low-value pentru testare unitară).
- `config.js`: adăugat `CORS_ORIGIN` (default `http://localhost:5173`); `.env.example` actualizat. `package.json` scripts: `start`/`dev` pointează acum pe `src/server.js`.
- 91 de teste noi în Stage 3 (errors:12 + error-handler:21 + not-found-handler:2 + health:5 + app:10 + 4 noi în config + 6 noi în error-handler pentru branch coverage). Total server: 189 passed + 5 integration skipped (no local Postgres).
- Praguri vitest pentru `src/middleware/**` (100%) acum în vigoare — `error-handler.js` și `not-found-handler.js` ating 100/100/100/100.

**Stage 1 — Testing infrastructure (2026-05-05):**
- `server/vitest.config.js` (CommonJS), `frontend/vitest.config.js` (ESM), praguri per glob conform tabelului din secțiunea Testing Rules
- **Important:** Vitest 2.x este pur ESM și NU poate fi importat via `require('vitest')` dintr-un modul CJS. Soluție aplicată: `globals: true` în vitest.config.js → fișierele `.test.js` folosesc `describe/it/expect/vi` direct ca globale, fără import. Codul aplicației rămâne CommonJS curat. Pattern-ul exemplu din CLAUDE.md (`const { describe, it } = require('vitest')`) trebuie evitat — folosiți globalele.
- Frontend: jsdom + @testing-library/jest-dom + @testing-library/react instalate; setup file la `frontend/tests/setup.js`; `passWithNoTests: true` până când avem componente reale
- Smoke test: `server/src/smoke.test.js` — verifică doar că Vitest rulează
- Husky 9 instalat (`prepare: husky` în root package.json); `.husky/pre-commit` rulează `pnpm -r test:run` + `pnpm -r lint`
- CI: `.github/workflows/ci.yml` — Node 20, pnpm 9, lint + test:run + test:coverage; coverage artifact uploaded
- **Lint este stub** (`echo "skipped"`) în ambele workspace-uri până când adăugăm config eslint flat — la nevoie în Stage 3+
- Praguri pe globs (`src/services/**`, etc.) sunt sărite când nu există fișiere care match-uiesc — vor intra automat în vigoare odată ce se adaugă cod în acele foldere

**Sub-stage 2b — Migration runner + SQL migrations + CI Postgres service (2026-05-05, code complete, NOT committed):**
- `server/src/db/migrate.js` — `applyMigrations(pool, dir, logger)`, `listAppliedMigrations`, `listMigrationFiles`. `_deps.fs` injectabil pentru teste.
- **Strategie de migrare** (vezi headerul `migrate.js` pentru detalii):
  1. Bootstrap idempotent al tabelei `schema_migrations` (CREATE IF NOT EXISTS).
  2. `pg_advisory_lock(MIGRATION_ADVISORY_LOCK_ID = 9182734)` pe o singură conexiune dedicată — Cloud Run poate scala simultan și două instanțe ar putea încerca să aplice migrațiile la pornire; lock-ul Postgres pe DB serializează aplicarea.
  3. Per fișier ne-aplicat: `BEGIN` → execută SQL → `INSERT` în `schema_migrations` → `COMMIT`. Pe orice eroare: `ROLLBACK` + throw cu filename inclus în mesaj. NU se continuă la următorul fișier după eșec.
  4. `pg_advisory_unlock` în `finally` — chiar și pe eșec, lock-ul e eliberat ca alte instanțe să poată reîncerca după fix.
- `server/src/db/migrate-cli.js` — wrapper CLI subțire, citește connection string din Secret Manager, apelează `applyMigrations`. Folosit local cu `pnpm migrate:shared` / `pnpm migrate:tenant <slug>`. Exclus din coverage (entry point fără logică de testat unitar).
- Migrații SQL:
  - `migrations/shared/001_init_shared.sql` — `amef_shared.tenants`, `amef_shared.tenant_users`, `amef_shared.audit_log_global`, indici și constrângeri (slug regex, role enum, status enum). Toate au `created_at`/`updated_at`/`deleted_at` per convențiile din CLAUDE.md.
  - `migrations/tenant/001_init_tenant_schema.sql` — DOAR `CREATE SCHEMA IF NOT EXISTS amef`. Tabelele tenant vin în Stage 5+.
- 18 unit tests pentru `migrate.js` (mock pool + fs prin `_deps`); 5 integration tests pe Postgres real (skipate local fără `TEST_DB_CONNECTION_STRING`, rulate în CI cu service container).
- `.github/workflows/ci.yml` — service container `postgres:18`, healthcheck `pg_isready`, env `TEST_DB_CONNECTION_STRING` injectat la step-urile `test:integration` și `test:coverage`.
- `server/package.json` și root `package.json`: scripturile `migrate:shared`/`migrate:tenant` apelează acum `migrate-cli.js`; `migrate:all` eliminat (nu reflectă D-per-tenant — fiecare DB tenant cere slug-ul lui).
- **Stage 2: search_path setat via connection-string options atât în integration tests cât și în producție (`pool.js`)** — abordarea inițială cu `pool.on('connect', SET search_path)` rulează SET asincron, fără await, iar pg-pool nu așteaptă listener-ele. În testul de integrare CI s-a manifestat ca race condition (schema_migrations creat în schema greșită cross-runs), dar și în producție rămânea o suprafață fragilă (retries de conexiune, timeouts de protocol). Fix aplicat consistent: connection string-ul include `?options=-c+search_path=<schema>,public`, pe care Postgres îl aplică ATOMIC la handshake — orice query pe acel client vede deja search_path-ul corect, garantat de protocol. Beneficii: defense-in-depth, atomic, mai puțin cod (handler `on('connect')` eliminat din ambele pool-uri tenant + shared). Helper-ul `withSearchPath(connectionString, schema)` face URL transform-ul cu `URL.searchParams`.
- **Stage 2: numele secretelor DB sunt derivate prin convenție (single source of truth)** — `utils/secret-naming.js` exportă `deriveSecretName(kind, env, slug?)` și `envFromNodeEnv(nodeEnv)`. Atât `pool.js` (derivă env din `NODE_ENV` via `_deps.getNodeEnv`) cât și `migrate-cli.js` (acceptă `--env production|staging`, default production) consumă helper-ul. `SHARED_DB_CONNECTION_SECRET_NAME` a fost eliminat din `config.js` și `.env.example` — nu mai există configurare ad-hoc a numelor. Vezi „Secret naming convention" mai sus pentru tabelul complet.
- **Stage 2: `migrate-cli` suportă flag-ul `--env production|staging`** — schema și migrationsDir nu se schimbă în funcție de env (rămân `amef_shared`/`amef`). Doar numele secretului diferă. `parseArgs` acceptă flag-ul în orice poziție în argv (`tenant --env staging dianex` e echivalent cu `tenant dianex --env staging`).
- **Stage 2: advisory lock acquired BEFORE `schema_migrations` DDL** — `applyMigrations` rulează acum `pg_advisory_lock` ca primă operațiune (după resolveSchema), apoi `CREATE SCHEMA IF NOT EXISTS` + `CREATE TABLE IF NOT EXISTS schema_migrations`. PostgreSQL `CREATE TABLE IF NOT EXISTS` NU e atomic față de DDL concurent — două instanțe care pornesc simultan pot trece amândouă de IF NOT EXISTS și apoi una eșuează cu „duplicate key value violates unique constraint pg_type_typname_nsp_index". S-a manifestat ca flake intermitent în CI la testul „aplicări concurente". Ordinea anterioară (DDL → lock → migrații) lăsa o fereastră de race; ordinea nouă (lock → DDL → migrații → unlock) serializează și bootstrap-ul.
- **Stage 2: `schema_migrations` e creat cu schema EXPLICITĂ pasată la runtime, nu prin search_path** — chiar și cu search_path setat corect la handshake, migrațiile-utilizator pot conține `SET search_path TO ...` (cum face de fapt `001_init_shared.sql`), iar acea schimbare persistă pentru restul sesiunii. Asta însemna că un `INSERT INTO schema_migrations` care urma migrației putea ateriza într-o schema diferită de cea în care fusese creată tabela — inconsistențe cross-runs ce manifestau ca teste de idempotency rupte intermitent în CI. Fix: `applyMigrations(pool, dir, { schema: 'amef_shared' })` — toate query-urile pe `schema_migrations` referă schema explicit ca `"<schema>".schema_migrations`. Numele schemei e sanitizat regex `[a-z0-9_]+` (interpolare în identificator nu poate fi parametrizată în pg). Default-ul (când `schema` lipsește) citește prima schema din `current_schemas(false)` — fallback util doar pentru smoke-tests.

**Sub-stage 2a — Config / Logger / Secret Manager / Pool (2026-05-05, code complete, NOT committed):**
- 4 module noi + tests collocated:
  - `server/src/config.js` + `config.test.js` — Zod schema cu preprocess pentru `''→default`, factory `loadConfig(env)` exportat alături de configul inghețat
  - `server/src/logger.js` + `logger.test.js` — Pino + `buildPinoOptions(cfg)` (testabil pur), `createChildLogger(bindings)`, transport `pino-pretty` activat doar pe `NODE_ENV=development`
  - `server/src/utils/secret-manager.js` + `secret-manager.test.js` — wrapper @google-cloud/secret-manager cu cache TTL 5 min, `ValidationError` (cu `.code`), `clearCache()` resetează și clientul
  - `server/src/db/pool.js` + `pool.test.js` — `Map` de pool-uri per tenant (`max:10`), shared pool (`max:5`), handler `connect` pentru `SET search_path TO amef[_shared], public`, `closeAllPools`, cleanup interval 30 min cu `unref()`
- **Lecție de testare în CJS:** `vi.mock` NU interceptează `require()` în CommonJS, iar `vi.resetModules()` nu curăță cache-ul native Node CJS. Soluții aplicate consistent în Stage 2a:
  1. **Test seam `_deps`** — modulele care depind de I/O (`secret-manager.js`, `pool.js`) exportă un obiect `_deps` mutabil cu `ClientClass` / `PoolClass` / `getSecret` / `logger`. Testele rescriu intrările pentru a injecta mock-uri. Producția nu atinge `_deps` decât pentru a citi clasa la prima instanțiere.
  2. **Factory exportate** — `config.loadConfig(env)` și `logger.buildPinoOptions(cfg)` permit testarea cu input-uri custom fără a depinde de re-execuția modulului.
  3. **Setup env la nivel de fișier** — fiecare `.test.js` apelează `vi.stubEnv` la top level înainte de primul `require('./module')` ca încărcarea inițială a configului să nu arunce.
- Coverage: 99.75% lines / 98.46% branches / 100% functions pe toate cele 4 module noi (țintă CLAUDE.md: 80%+).
- **NU am modificat** `vitest.config.js`, `package.json` scripts, sau CI workflow — toate rămân pentru Sub-stage 2b.

---

## Reference documents

For detailed context, see:
- **`portal-amef-overview.md`** (in Knowledge Base of Claude project) — full architecture, decisions D1-D20, terminology, **Section 4 Testing Philosophy**
- **`portal-amef-staff-plan.md`** (in Knowledge Base) — detailed plan of all 15 stages with extended Definition of Done

If a decision is needed that isn't documented, **stop and ask Madalin** before proceeding.

---

## Document version

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-05 | Initial CLAUDE.md post Stage 0 (Analysis) |
| 2.0 | 2026-05-05 | Added Testing Rules (mandatory) section + CI gating + workflow per function |
