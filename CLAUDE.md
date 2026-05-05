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
- Migrations include `SET search_path TO amef, public;` at start

---

## Auth flow (Stage 4)

**Decizie D6 (MVP):** Google SSO ONLY via Firebase Identity Platform.
Email/parolă și Microsoft SSO sunt amânate până când avem un tenant care nu
e Google Workspace. 2FA e delegat lui Google (ex: Dianex folosește
YubiKey/TOTP pe contul Google). Backend-ul REFUZĂ login dacă token-ul
Firebase nu are claim de second factor (`firebase.sign_in_second_factor`
sau custom claim `mfa_verified === true`) — răspuns 403 cu mesaj clar.

**Fluxul end-to-end:**
1. Frontend: utilizatorul apasă „Login cu Google" → Firebase Web SDK
   declanșează popup-ul Google Sign-In (Google validează 2FA dacă e
   configurat pe cont).
2. Firebase emite un `idToken` (JWT semnat de Google) către frontend.
3. Frontend face `POST /api/v1/auth/firebase-login { idToken }`.
4. Backend (`auth-service.validateFirebaseToken`):
   - Verifică `idToken` cu firebase-admin (semnătură + expirare).
   - Verifică prezența claim-ului de 2FA — altfel 403.
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

**Current stage:** Stage 4 Part A — Backend auth (Firebase Google SSO + own JWT). Code & tests complete, pending review.
**Last completed stage:** Stage 3 — Express app bootstrap (merged on main).
**Next action:** Stage 4 Part B — Frontend (login page, Firebase Web SDK, refresh token storage, route guards).

### Completed stages
- [x] Stage 1 — Setup project and structure (incl. testing infrastructure)
- [x] Stage 2 — Setup databases and migration runner (with tests)
- [x] Stage 3 — Express app bootstrap (merged)
- [~] Stage 4 — Login and Tenant Resolution (Part A backend done; Part B frontend pending)
- [ ] Stage 5 — Clients module with ANAF auto-completion (with full test suite)
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
Last `pnpm test` run: 2026-05-05 (Stage 4 Part A complete) — server: 244 passed + 20 integration skipped
  (no local Postgres), frontend: 0 (passWithNoTests)
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

**Stage 4 Part A — Backend auth (Google SSO + own JWT) (2026-05-05, code complete, NOT committed):**
- Decizie **D6 update**: Google SSO ONLY pentru MVP. Email/parolă și Microsoft SSO sunt amânate până când avem un tenant non-Workspace. 2FA delegat lui Google (Dianex are YubiKey + cont Google). Refuzăm login dacă token-ul Firebase nu are claim de second factor — vezi „Auth flow" mai sus pentru detalii.
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
