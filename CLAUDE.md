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
- Custom error classes: `ValidationError`, `NotFoundError`, `UnauthorizedError`, `ForbiddenError`

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
SHARED_DB_CONNECTION_SECRET_NAME=shared-db-connection|shared-db-connection-staging
GCP_PROJECT_ID=portal-amef

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

**Current stage:** Stage 2 — Setup databases and migration runner (next)
**Last completed stage:** Stage 1 — Setup project and structure (incl. testing infrastructure) (2026-05-05)
**Next action:** Start Stage 2 — create Cloud SQL databases (`amef_shared`, `amef_shared_staging`, `amef_tenant_dianex`, `amef_tenant_dianex_staging`), users, secrets, and the migration runner.

### Completed stages
- [x] Stage 1 — Setup project and structure (incl. testing infrastructure)
- [ ] Stage 2 — Setup databases and migration runner (with tests)
- [ ] Stage 3 — Connection pool and logger (with tests)
- [ ] Stage 4 — Login and Tenant Resolution (with full test suite)
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
Last `pnpm test` run: 2026-05-05 — server: 1 passed (smoke.test.js), frontend: 0 (passWithNoTests)
Last `pnpm test:coverage` run: 2026-05-05 — both workspaces produced reports, no thresholds violated
Coverage (target / actual):
  - services:   80% / no files yet (threshold skipped)
  - middleware: 100% / no files yet (threshold skipped)
  - routes:     70% / no files yet (threshold skipped)
  - frontend components: 70% / no files yet (threshold skipped)
  - frontend hooks: 70% / no files yet (threshold skipped)
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

**Stage 1 — Testing infrastructure (2026-05-05):**
- `server/vitest.config.js` (CommonJS), `frontend/vitest.config.js` (ESM), praguri per glob conform tabelului din secțiunea Testing Rules
- **Important:** Vitest 2.x este pur ESM și NU poate fi importat via `require('vitest')` dintr-un modul CJS. Soluție aplicată: `globals: true` în vitest.config.js → fișierele `.test.js` folosesc `describe/it/expect/vi` direct ca globale, fără import. Codul aplicației rămâne CommonJS curat. Pattern-ul exemplu din CLAUDE.md (`const { describe, it } = require('vitest')`) trebuie evitat — folosiți globalele.
- Frontend: jsdom + @testing-library/jest-dom + @testing-library/react instalate; setup file la `frontend/tests/setup.js`; `passWithNoTests: true` până când avem componente reale
- Smoke test: `server/src/smoke.test.js` — verifică doar că Vitest rulează
- Husky 9 instalat (`prepare: husky` în root package.json); `.husky/pre-commit` rulează `pnpm -r test:run` + `pnpm -r lint`
- CI: `.github/workflows/ci.yml` — Node 20, pnpm 9, lint + test:run + test:coverage; coverage artifact uploaded
- **Lint este stub** (`echo "skipped"`) în ambele workspace-uri până când adăugăm config eslint flat — la nevoie în Stage 3+
- Praguri pe globs (`src/services/**`, etc.) sunt sărite când nu există fișiere care match-uiesc — vor intra automat în vigoare odată ce se adaugă cod în acele foldere

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
