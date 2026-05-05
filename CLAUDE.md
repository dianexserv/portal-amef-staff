# CLAUDE.md — portal-amef-staff

> **Acest fișier este citit de Claude Code CLI la fiecare sesiune.**
> Conține contextul curent al aplicației, convențiile de cod și starea curentă a construcției.
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
- Vitest + Supertest + Bruno for testing
- pnpm package manager

### Frontend
- React 18+ with Vite
- Tailwind CSS
- **JavaScript pure** (NO TypeScript)
- Functional components + Hooks

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
- CI: GitHub Actions
- CD: Cloud Build with triggers on tags

---

## Folder structure

```
portal-amef-staff/
├── server/
│   └── src/
│       ├── routes/               ← only routing
│       ├── controllers/          ← validation, calls services
│       ├── services/             ← business logic, calls DB
│       ├── db/
│       │   ├── pool.js           ← pool cache per tenant + SET search_path
│       │   ├── migrate.js        ← migration runner
│       │   ├── migrations/
│       │   │   ├── shared/       ← migrations for amef_shared DB
│       │   │   └── tenant/       ← migrations for amef_tenant_* DBs
│       │   └── setup/            ← initial setup SQL scripts
│       ├── middleware/           ← auth, validate, error-handler, require-role
│       ├── utils/                ← secret-manager, helpers
│       ├── logger.js             ← Pino setup
│       ├── config.js             ← env vars validated with Zod
│       └── app.js                ← Express app entry
├── frontend/
│   ├── src/
│   │   ├── components/           ← reusable UI components
│   │   ├── pages/                ← route pages
│   │   ├── hooks/                ← custom React hooks
│   │   └── utils/                ← helpers, API client
│   └── ...
├── docs/                         ← additional docs (ADRs, diagrams)
├── tests/
│   ├── unit/                     ← Vitest unit tests
│   └── integration/              ← Supertest integration tests
├── bruno/                        ← Bruno API collection
├── Dockerfile                    ← multi-stage build
├── .env.example                  ← all env vars with dummy values
├── .gitignore
├── .dockerignore
├── package.json                  ← workspace root
├── pnpm-workspace.yaml
├── README.md
└── CLAUDE.md                     ← this file
```

---

## Code conventions (MANDATORY)

### Filenames
- **kebab-case** mandatory: `client-service.js`, `auth-middleware.js`, `pool.js`
- NO camelCase: `clientService.js` ❌
- NO PascalCase: `ClientService.js` ❌

### Functions and variables
- **camelCase** for functions and variables: `getClientByCui`, `tenantSlug`
- **UPPER_SNAKE_CASE** for constants: `MAX_RETRY_COUNT`, `JWT_EXPIRY_HOURS`
- **PascalCase** for classes (rare): `ErpAdapter`, `NexusErpAdapter`

### Module pattern (CommonJS)

```javascript
// File: services/client-service.js

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

# Run tests
pnpm test
pnpm test:coverage

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
# Deploy staging (auto on push to develop)
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

---

## Build progress (current state)

> **This section is updated after each completed stage.**

**Current stage:** Stage 2 — Setup databases and migration runner (next)
**Last completed stage:** Stage 1 — Setup project and structure (2026-05-05)
**Next action:** Start Stage 2 — create Cloud SQL databases (`amef_shared`, `amef_shared_staging`, `amef_tenant_dianex`, `amef_tenant_dianex_staging`), users, secrets, and the migration runner.

### Completed stages
- [x] Stage 1 — Setup project and structure
- [ ] Stage 2 — Setup databases and migration runner
- [ ] Stage 3 — Connection pool and logger
- [ ] Stage 4 — Login and Tenant Resolution
- [ ] Stage 5 — Clients module with ANAF auto-completion
- [ ] Stage 6 — Integration with erp-sync
- [ ] Stage 7 — Articles + Invoicing module
- [ ] Stage 8 — Cash registers + Technical dossier
- [ ] Stage 9 — Integration with anaf-signer
- [ ] Stage 10 — Fiscal flow module (C801 + F4102)
- [ ] Stage 11 — Documents + DOCX generator
- [ ] Stage 12 — Audit log + Dashboard Configurare Tenant
- [ ] Stage 13 — Drive migration (Dianex)
- [ ] Stage 14 — End-to-end testing + Bug fixing
- [ ] Stage 15 — Production deploy + Monitoring

### Notes from build

**Stage 1 (2026-05-05):**
- pnpm workspace cu 2 pachete: `server` (`@portal-amef-staff/server`) și `frontend` (`@portal-amef-staff/frontend`)
- Backend: Express, pg, Zod, Pino + pino-http, Helmet, cors, express-rate-limit, jsonwebtoken, firebase-admin, @google-cloud/secret-manager, dotenv. Dev: vitest + @vitest/coverage-v8, supertest, eslint, prettier, pino-pretty
- Frontend: React 18 + Vite 5 + Tailwind 3 (postcss + autoprefixer). Config Vite cu proxy `/api` → `http://localhost:3001` pentru dev fără CORS
- Build scripts approved în `pnpm.onlyBuiltDependencies` din root `package.json`: `esbuild`, `protobufjs` (necesare pentru Vite și firebase-admin)
- Folosim `.gitkeep` pentru a păstra în git folderele goale ale structurii (`server/src/routes`, `controllers`, `services`, `middleware`, `db/{migrations/{shared,tenant},setup}`, `utils`; `frontend/src/{components,pages,hooks,utils}`; `tests/{unit,integration}`; `bruno`; `docs`)
- `app.js`, `config.js`, `logger.js` NU sunt create încă — apar la Stage 3 conform planului

---

## Reference documents

For detailed context, see:
- **`portal-amef-overview.md`** (in Knowledge Base of Claude project) — full architecture, decisions D1-D20, terminology
- **`portal-amef-staff-plan.md`** (in Knowledge Base) — detailed plan of all 15 stages

If a decision is needed that isn't documented, **stop and ask Madalin** before proceeding.

---

## Document version

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-05 | Initial CLAUDE.md post Stage 0 (Analysis) |
