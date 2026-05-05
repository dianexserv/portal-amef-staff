-- Migrația 002 pentru DB-uri de tenant (`amef_tenant_<slug>`).
--
-- Forward-fix pentru divergențele identificate după ce 001 a fost aplicat
-- pe staging. NU modificăm 001 — odată ce o migrație e aplicată, e
-- imutabilă; corecturile vin ca migrații noi pe care `migrate.js` le
-- aplică în ordine la următorul deploy.
--
-- ─────────────────────────────────────────────────────────────────────────
-- Bloc 1 — Relaxare NOT NULL pe câmpurile reprezentantului legal.
-- ─────────────────────────────────────────────────────────────────────────
-- De ce: la migrarea datelor din Drive (Stage 13) o parte din clienții
-- vechi (PFA, II-uri arhivate) NU au date complete despre reprezentant.
-- În 001 am marcat aceste câmpuri ca NOT NULL pentru clienții noi creați
-- din UI (unde validarea e obligatorie), dar la import legacy avem
-- nevoie să acceptăm rânduri parțiale.
--
-- Datele de identificare a COMPANIEI rămân NOT NULL: ele vin din ANAF
-- (CUI + denumire + adresă sediu) și sunt garantate disponibile pentru
-- orice client cu CUI valid. Doar reprezentantul e relaxat.
--
-- Validarea „cont nou via UI cere reprezentant complet" se mută în
-- service layer (Zod schema în client-service.js — Stage 5b). DB-ul e
-- relaxat ca să poată găzdui datele legacy; logica de business face
-- distincția între „rând complet creat azi" și „rând importat din Drive".
--
-- ALTER ALTER COLUMN ... DROP NOT NULL e instant pe Postgres (modifică
-- doar catalog-ul, nu rescrie tabela), deci e safe pe production cu date.

ALTER TABLE amef.core_clients ALTER COLUMN representative_name DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_role_id DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_ci_number DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_ci_issued_by DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_ci_issued_at DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_county DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_city DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_street DROP NOT NULL;
ALTER TABLE amef.core_clients ALTER COLUMN representative_street_number DROP NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- Bloc 2 — Cache ANAF + regulă „cel puțin un canal de contact".
-- ─────────────────────────────────────────────────────────────────────────
-- anaf_data JSONB: stocăm răspunsul complet primit de la ANAF webservice
-- (vector + adresă + cod CAEN + status TVA + status TVA-incasare etc.).
-- Două motivații:
--   (a) Graceful fallback când ANAF API e jos: avem date locale de
--       afișat (cu un timestamp clar de „ultima verificare reușită").
--   (b) Cron-ul zilnic de re-verificare (Stage 6) compară JSON-ul nou cu
--       cel cached și flag-uiește schimbări (ex: companie devine inactivă,
--       își schimbă sediul, intră în TVA la încasare). Fără cache n-am
--       avea cu ce compara.
-- JSONB (nu JSON) pentru indexare GIN ulterior dacă vrem să interogăm
-- pe sub-câmpuri (ex: "toți clienții cu cod CAEN 6201").
--
-- phone_or_email_required: cel puțin un canal de contact e necesar
-- pentru a putea trimite documentele generate (factură, contract, dosar
-- tehnic). În 001 ambele câmpuri erau optionale individual; constrângerea
-- la nivel de rând prinde cazul în care utilizatorul lasă goale ambele.
--
-- Pattern-ul NOT VALID + VALIDATE:
--   - ADD CONSTRAINT ... NOT VALID adaugă regula DOAR pentru rânduri noi
--     și UPDATE-uri viitoare; NU verifică datele existente. E o operație
--     instant, fără table scan, fără lock exclusiv pe durată lungă.
--   - VALIDATE CONSTRAINT face validation pe rândurile existente cu un
--     lock mai blând (SHARE UPDATE EXCLUSIVE — citirile și INSERT-urile
--     pot continua, doar alte ALTER-uri sunt blocate).
-- Pe staging, tabela e goală și ambele pași sunt instant. Pe production
-- cu date pattern-ul previne lock-ul lung de tip ACCESS EXCLUSIVE pe care
-- l-ar genera un ADD CONSTRAINT clasic. E good practice să-l folosim
-- de la început, ca să nu trebuiască să-l învățăm sub presiune când
-- chiar avem date.

ALTER TABLE amef.core_clients ADD COLUMN anaf_data JSONB;

ALTER TABLE amef.core_clients
  ADD CONSTRAINT phone_or_email_required
  CHECK (phone IS NOT NULL OR email IS NOT NULL) NOT VALID;

ALTER TABLE amef.core_clients VALIDATE CONSTRAINT phone_or_email_required;

-- ─────────────────────────────────────────────────────────────────────────
-- Bloc 3 — Upgrade index pentru search pe denumire companie.
-- ─────────────────────────────────────────────────────────────────────────
-- B-tree-ul din 001 (idx_core_clients_company_name) ajută DOAR la lookup
-- exact și la prefix-search (`WHERE company_name LIKE 'SC ABC%'`). Pentru
-- bara de căutare din UI (`ILIKE '%abc%'` — substring oriunde), B-tree-ul
-- nu e folosit deloc → seq scan pe toată tabela.
--
-- pg_trgm + GIN(gin_trgm_ops) sparge string-urile în trigrame de 3
-- caractere și indexează-le; funcționează cu ILIKE/LIKE/SIMILAR oriunde
-- în string și cu similaritatea (operatorul `%` din pg_trgm — util la
-- "did you mean" suggestions). Costul: index-ul e mai mare decât B-tree
-- și INSERT-urile sunt cu ~10-20% mai lente. Trade-off acceptabil pentru
-- un tabel cu read >> write (clienți se caută mult, se creează rar).
--
-- CREATE EXTENSION înainte de CREATE INDEX — pg_trgm aduce operatorul
-- gin_trgm_ops; fără el, CREATE INDEX ar arunca "operator class does
-- not exist". IF NOT EXISTS pe extension face migrația idempotentă.
--
-- DROP INDEX IF EXISTS face migrația tolerantă la re-rulare manuală
-- în cazuri de debug (deși runner-ul tracking-uiește 002 în
-- schema_migrations și nu o re-rulează în mod normal).

CREATE EXTENSION IF NOT EXISTS pg_trgm;

DROP INDEX IF EXISTS amef.idx_core_clients_company_name;

CREATE INDEX idx_core_clients_company_name_trgm
  ON amef.core_clients
  USING gin (company_name gin_trgm_ops);

-- ─────────────────────────────────────────────────────────────────────────
-- Bloc 4 — Înlocuire index „active" cu unul recent-active mai util.
-- ─────────────────────────────────────────────────────────────────────────
-- idx_core_clients_active din 001 era CREATE INDEX (deleted_at) WHERE
-- deleted_at IS NULL. Sună bine, dar planner-ul Postgres nu-l folosește
-- aproape niciodată: nu există query-uri care să sorteze sau filtreze
-- după valoarea coloanei `deleted_at` în setul de active (toate sunt
-- NULL acolo, deci index-ul nu discrimină nimic). E doar overhead la
-- INSERT/UPDATE.
--
-- Ce VOM interoga frecvent: „lista clienților activi, ordonați după
-- created_at DESC" (UI: pagina principală a modulului Clienți; cron-uri
-- batch processing recente). Index-ul corect e (created_at DESC) cu
-- predicat WHERE deleted_at IS NULL — Postgres îl poate scana în ordine
-- pentru ORDER BY și restrânge automat la non-deleted.

DROP INDEX IF EXISTS amef.idx_core_clients_active;

CREATE INDEX idx_core_clients_recent_active
  ON amef.core_clients (created_at DESC)
  WHERE deleted_at IS NULL;
