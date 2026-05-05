-- Migrația 001 pentru DB-uri de tenant (`amef_tenant_<slug>`).
--
-- Sub-stage 2b: această migrație creează DOAR schema `amef`. Tabelele
-- propriu-zise (core_clients, core_cash_registers, staff_invoices, etc.) sunt
-- adăugate de migrațiile următoare, în stage-urile relevante:
--   - Stage 5 → core_clients (modul Clienți + ANAF auto-completion)
--   - Stage 7 → staff_invoices, staff_payments, core_articles
--   - Stage 8 → core_cash_registers, core_documents (dosar tehnic)
--   - Stage 10 → staff_declarations (C801 / F4102)
--   - Stage 12 → audit_log
--
-- Scopul migrației de aici este doar să validăm că runner-ul funcționează pe
-- DB-uri de tenant la fel ca pe `amef_shared` — un test end-to-end al
-- pipeline-ului de migrare înainte să avem schema reală.

SET search_path TO amef, public;

-- Schema dedicată — toate tabelele tenantului trăiesc aici, NU în `public`.
-- Permisiunile de tenant_dianex_app sunt acordate doar pe această schema.
CREATE SCHEMA IF NOT EXISTS amef;

COMMENT ON SCHEMA amef IS
  'Schema principală a DB-ului de tenant (Portal AMEF Staff). Tabelele din Stage 5+.';
