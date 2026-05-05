# portal-amef-staff

Backend Express + Frontend React (PWA) pentru Portal AMEF — modulul `staff`.

Aplicație multi-tenant (DB-per-tenant pe instanță Cloud SQL partajată) destinată echipei interne pentru gestiunea clienților, parcului de case de marcat, fiscalizărilor C801/F4102, facturării și documentelor.

## Stack

- **Backend:** Node.js 20+, Express, `pg` direct (fără ORM), Zod, Pino, JavaScript pur (CommonJS)
- **Frontend:** React 18 + Vite + Tailwind CSS, JavaScript pur
- **Auth:** Firebase Identity Platform + JWT propriu (claims `tenant_slug`, `role`, `firebase_uid`)
- **DB:** PostgreSQL 18 pe Cloud SQL (`europe-west1`), schema `amef` per tenant
- **Deploy:** Cloud Run (`europe-west1`), staging și production izolate

Pentru context complet, vezi `CLAUDE.md`.

## Cerințe locale

- Node.js >= 20
- pnpm >= 10
- Cloud SQL Auth Proxy (pentru conexiune la DB)
- `gcloud` CLI autentificat pe proiectul `portal-amef`

## Setup local

```bash
# Instalare dependențe (toate workspace-urile)
pnpm install

# Copiere config exemplu
cp .env.example .env
# Completați valorile reale în .env
```

## Rulare locală

```bash
# Backend (port 3001)
cd server
pnpm dev

# Frontend (port 5173)
cd frontend
pnpm dev
```

## Teste

```bash
pnpm test
pnpm test:coverage
```

## Structură

```
portal-amef-staff/
├── server/      ← backend Express
├── frontend/    ← frontend React + Vite
├── tests/       ← Vitest unit + Supertest integration
├── bruno/       ← colecție API Bruno
└── docs/        ← ADRs, diagrame
```

## Documentație

- `CLAUDE.md` — context curent, convenții cod, stare construcție
- `docs/` — ADRs, diagrame arhitecturale
