-- Migrația 001 pentru DB-uri de tenant (`amef_tenant_<slug>`).
--
-- Stage 5a — schema modulului Clienți. Conține:
--   - amef.core_representative_roles: tabelă de lookup pentru rolul
--     reprezentantului legal (administrator, PFA, titular II, CMI, etc.).
--   - amef.core_clients: clienții tenantului — date de identificare fiscală,
--     adresă companie, contact, reprezentant legal, banking, status ANAF.
--   - Seed: 6 roluri inițiale ca FE-ul să poată afișa dropdown-ul fără
--     setup manual la onboarding-ul unui tenant nou.
--
-- Decizii de design:
--   - `created_by_id` din core_clients referă `amef_shared.tenant_users.id`
--     dar NU e declarat ca FK. Tabela parent trăiește în alt DB (model C —
--     DB-per-tenant), iar Postgres nu suportă FK cross-database. Validarea
--     se face în service layer: middleware-ul de auth populează `req.user.id`
--     la insert, deci valoarea vine din tokenul JWT verificat — nu din input
--     user-controlled.
--   - `representative_role_id` E un FK normal (intra-DB) către
--     `core_representative_roles` ca să garantăm consistența la nivel DB
--     (UI-ul nu poate trimite valori arbitrare).
--   - UNIQUE NULLS NOT DISTINCT (col, deleted_at) pentru fiscal_code și
--     email (Postgres 15+; Cloud SQL e pe 18). Idiomul „uniqueness printre
--     non-deleted": când un client e soft-deleted (`deleted_at` ← NOW()),
--     tuplul lui nu mai e considerat egal cu cel al unui client nou cu
--     același fiscal_code → re-create e permis. Fără NULLS NOT DISTINCT,
--     `deleted_at` NULL n-ar fi luat în calcul la egalitate.
--   - email e UNIQUE per tenant pentru că în Faza B (portal client public)
--     devine identitate de login alături de Google SSO al tenantului.
--   - Index parțial WHERE deleted_at IS NULL pe lista de clienți activi —
--     listing-ul standard filtrează soft-deleted, deci index-ul e mai mic
--     și mai rapid decât unul full pe deleted_at.
--   - Index parțial WHERE anaf_verified = false pentru cron-ul de
--     re-verificare ANAF (Stage 6) — la 100k+ clienți, scanarea fără index
--     ar fi prohibitivă; restrângerea la cei neverificați face setul mic.
--   - NU folosim `SET search_path TO amef, public` la începutul fișierului.
--     Toate referirile la tabele sunt fully-qualified (`amef.core_clients`).
--     Avantaj: imune la migrațiile-utilizator care ar putea muta search_path
--     mid-session, și runner-ul (migrate.js) tracking-uiește `schema_migrations`
--     prin schema explicită oricum.

CREATE SCHEMA IF NOT EXISTS amef;

COMMENT ON SCHEMA amef IS
  'Schema principală a DB-ului de tenant (Portal AMEF Staff).';

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela `core_representative_roles` — lookup pentru rolul reprezentantului
-- legal al unui client (administrator, PFA, titular CMI, etc.).
--   Tabelă mică (≤10 rânduri). Populată prin seed la migrare. UI-ul filtrează
--   pe `is_active = true` și ordonează după `sort_order` pentru dropdown.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE amef.core_representative_roles (
  id          SERIAL       PRIMARY KEY,
  code        VARCHAR(50)  NOT NULL UNIQUE,
  label       VARCHAR(255) NOT NULL,
  is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
  sort_order  INTEGER      NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE amef.core_representative_roles IS
  'Rolul reprezentantului legal al unui client — lookup pentru core_clients.representative_role_id.';

-- ─────────────────────────────────────────────────────────────────────────
-- Tabela `core_clients` — clienții tenantului.
--   Vezi headerul fișierului pentru decizii de design (FK cross-DB,
--   UNIQUE NULLS NOT DISTINCT, indici parțiali).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE amef.core_clients (
  id                            SERIAL       PRIMARY KEY,

  -- Identificare fiscală
  fiscal_code                   VARCHAR(20)  NOT NULL,
  fiscal_code_type              VARCHAR(10)  NOT NULL
                                CHECK (fiscal_code_type IN ('CUI', 'CNP')),
  company_name                  VARCHAR(255) NOT NULL,
  is_vat_payer                  BOOLEAN      NOT NULL DEFAULT FALSE,

  -- Adresă companie
  address_full                  TEXT,
  county                        VARCHAR(50)  NOT NULL,
  city                          VARCHAR(100) NOT NULL,
  street                        VARCHAR(255) NOT NULL,
  street_number                 VARCHAR(20)  NOT NULL,
  address_extra                 VARCHAR(255),
  postal_code                   VARCHAR(10),

  -- Contact (email = identitate login portal client în Faza B)
  phone                         VARCHAR(50),
  email                         VARCHAR(255),

  -- Reprezentant legal
  representative_role_id        INTEGER      NOT NULL
                                REFERENCES amef.core_representative_roles(id),
  representative_name           VARCHAR(255) NOT NULL,
  representative_ci_series      VARCHAR(5),
  representative_ci_number      VARCHAR(20)  NOT NULL,
  representative_ci_issued_by   VARCHAR(255) NOT NULL,
  representative_ci_issued_at   DATE         NOT NULL,
  representative_address_full   TEXT,
  representative_county         VARCHAR(50)  NOT NULL,
  representative_city           VARCHAR(100) NOT NULL,
  representative_street         VARCHAR(255) NOT NULL,
  representative_street_number  VARCHAR(20)  NOT NULL,
  representative_address_extra  VARCHAR(255),
  representative_postal_code    VARCHAR(10),

  -- Bancar (opțional — completat după ce avem confirmarea de la client)
  iban                          VARCHAR(34),
  bank_name                     VARCHAR(100),

  -- Status ANAF (verificare automată sau manuală via Stage 5/6)
  anaf_verified                 BOOLEAN      NOT NULL DEFAULT FALSE,
  anaf_verified_at              TIMESTAMPTZ,
  anaf_status                   VARCHAR(20),

  -- Note libere ale staff-ului tenantului
  notes                         TEXT,

  -- Audit
  created_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at                    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  deleted_at                    TIMESTAMPTZ,
  -- Cross-DB ref către amef_shared.tenant_users.id; vezi headerul pentru
  -- justificare (Postgres nu suportă FK cross-database).
  created_by_id                 INTEGER      NOT NULL,

  CONSTRAINT fiscal_code_unique_active
    UNIQUE NULLS NOT DISTINCT (fiscal_code, deleted_at)
);

COMMENT ON TABLE amef.core_clients IS
  'Clienții tenantului — identificare fiscală, adresă, reprezentant legal, banking, status ANAF.';

-- Lookup direct pe cod fiscal (folosit la verificări duplicat și de Stage 7
-- pentru asocierea factură ↔ client).
CREATE INDEX idx_core_clients_fiscal_code
  ON amef.core_clients (fiscal_code);

-- Search pe denumire companie (UI: bara de căutare în lista de clienți).
CREATE INDEX idx_core_clients_company_name
  ON amef.core_clients (company_name);

-- Cron-ul de (re-)verificare ANAF din Stage 6 iterează numai pe clienții
-- neverificați; partial index restrânge enorm setul scanat.
CREATE INDEX idx_core_clients_anaf_pending
  ON amef.core_clients (anaf_verified)
  WHERE anaf_verified = FALSE;

-- Listing-ul standard de clienți (UI + servicii) filtrează soft-deleted;
-- index-ul parțial pe deleted_at IS NULL e cel hot-path-ul.
CREATE INDEX idx_core_clients_active
  ON amef.core_clients (deleted_at)
  WHERE deleted_at IS NULL;

-- Lookup pe email pentru login portal client (Faza B). Index parțial
-- pentru că majoritatea clienților din MVP nu au email completat.
CREATE INDEX idx_core_clients_email
  ON amef.core_clients (email)
  WHERE email IS NOT NULL;

-- Email UNIQUE doar când nu e NULL și clientul e activ.
-- Folosim partial index în loc de UNIQUE NULLS NOT DISTINCT pentru că
-- mulți clienți (PFA vechi, persoane fizice) nu au email și trebuie să coexiste.
CREATE UNIQUE INDEX idx_core_clients_email_unique_active
  ON amef.core_clients (email)
  WHERE email IS NOT NULL AND deleted_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Seed inițial — 6 roluri de reprezentant. Etichetele sunt în ASCII pur
-- (fără diacritice) ca să evităm probleme de encoding la export DOCX
-- (Stage 11) sau la CSV-uri descărcate. UI-ul afișează aceste valori
-- ca atare; nu există mapare către forme cu diacritice.
-- ─────────────────────────────────────────────────────────────────────────
INSERT INTO amef.core_representative_roles (code, label, sort_order) VALUES
  ('administrator', 'Administrator',                    1),
  ('pfa',           'Persoana Fizica Autorizata (PFA)', 2),
  ('titular_ii',    'Titular I.I.',                     3),
  ('titular_cmi',   'Titular CMI',                      4),
  ('asociat_unic',  'Asociat Unic',                     5),
  ('imputernicit',  'Persoana Imputernicita',           6);
