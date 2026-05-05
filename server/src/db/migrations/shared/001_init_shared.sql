-- Migrația 001 pentru DB-ul partajat (`amef_shared` / `amef_shared_staging`).
--
-- Conține metadata cross-tenant: lista tenanților, utilizatorii lor (cu rolurile)
-- și un audit log global pentru acțiuni administrative la nivel platformă.
-- Fiecare rând din `tenants` corespunde unui DB dedicat (model C — DB-per-tenant).

SET search_path TO amef_shared, public;

-- Schema dedicată — separăm de `public` ca să putem acorda granule de acces
-- per-rol în Postgres (ex: app_shared poate avea USAGE pe amef_shared, dar nu
-- pe alte schema-uri sau pe `public`).
CREATE SCHEMA IF NOT EXISTS amef_shared;

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela `tenants` — registrul central al tenanților AMEF.
--   - `slug`: identificator stabil folosit în routing și în numele DB-ului
--     dedicat (`amef_tenant_<slug>`). Constrângerea regex previne caractere
--     care ar sparge connection string-ul sau path-ul URL.
--   - `cui`: codul fiscal românesc (poate avea prefix RO sau nu — validat de
--     ANAF service la creare; aici stocăm orice formă pentru istorie).
--   - `status`: 'active' default; 'suspended' blochează login-ul, 'archived'
--     înseamnă off-boarded (DB-ul tenant rămâne pentru retenție 7 ani).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amef_shared.tenants (
  id            SERIAL PRIMARY KEY,
  slug          VARCHAR(50)  NOT NULL UNIQUE
                CHECK (slug ~ '^[a-z0-9-]+$'),
  company_name  VARCHAR(255) NOT NULL,
  cui           VARCHAR(20)  NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'archived')),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ  NULL
);

COMMENT ON TABLE amef_shared.tenants IS
  'Registrul tenanților AMEF — un rând per organizație, slug-ul determină DB-ul dedicat.';

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela `tenant_users` — utilizatorii și rolurile lor în fiecare tenant.
--   - `firebase_uid`: identitatea Firebase (Google SSO sau email/parolă + 2FA).
--     UNIQUE cu `tenant_id` permite ca un platform_operator să fie listat în
--     toate tenanții pe care îi suportă.
--   - `role`: 3 roluri (vezi CLAUDE.md / Roles in Portal AMEF).
--   - INDEX pe `firebase_uid` ca login-ul să fie O(log n) — se interogăsește
--     la fiecare verificare de token JWT pentru tenant resolution.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amef_shared.tenant_users (
  id            SERIAL PRIMARY KEY,
  tenant_id     INTEGER      NOT NULL
                REFERENCES amef_shared.tenants(id) ON DELETE CASCADE,
  firebase_uid  VARCHAR(128) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  role          VARCHAR(30)  NOT NULL
                CHECK (role IN ('tenant_admin', 'tenant_user', 'platform_operator')),
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ  NULL,
  UNIQUE (tenant_id, firebase_uid)
);

COMMENT ON TABLE amef_shared.tenant_users IS
  'Membri per tenant — leagă firebase_uid de rol; folosit la rezolvarea sesiunii.';

CREATE INDEX IF NOT EXISTS idx_tenant_users_firebase_uid
  ON amef_shared.tenant_users (firebase_uid);

CREATE INDEX IF NOT EXISTS idx_tenant_users_email
  ON amef_shared.tenant_users (email);

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela `audit_log_global` — evenimente la nivel platformă (cross-tenant).
--   Audit-ul per-tenant (pentru actiuni în contextul unui tenant) trăiește în
--   DB-ul tenant-ului (`amef.audit_log`). Aici păstrăm doar acțiunile pe care
--   le facem din Dashboard Configurare Tenant (creare tenant, suspend, etc.).
--   - `details JSONB` — payload arbitrar; preferăm JSONB peste text pentru
--     query-uri pe sub-câmpuri.
--   - INDEX (tenant_slug, created_at DESC) pentru "ultimele N acțiuni pentru
--     tenant X" — modul de filtrare cel mai frecvent în UI-ul de audit.
--   - INDEX pe actor_email pentru "ce a făcut utilizatorul X" în triage.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS amef_shared.audit_log_global (
  id             BIGSERIAL    PRIMARY KEY,
  tenant_slug    VARCHAR(50)  NOT NULL,
  actor_email    VARCHAR(255),
  action         VARCHAR(100) NOT NULL,
  resource_type  VARCHAR(100),
  resource_id    VARCHAR(100),
  details        JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE amef_shared.audit_log_global IS
  'Audit log la nivel platformă — acțiuni administrative cross-tenant (Configurare Tenant).';

CREATE INDEX IF NOT EXISTS idx_audit_global_tenant_created
  ON amef_shared.audit_log_global (tenant_slug, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_global_actor
  ON amef_shared.audit_log_global (actor_email);
