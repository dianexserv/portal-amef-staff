// /health — endpoint pentru liveness/readiness probes (Cloud Run, Uptime
// Robot, etc.). Răspunde rapid cu 200 fără să atingă DB-ul, ca să distingem
// procesul „alive" de „DB inaccesibil".
//
// Cu `?check=db` facem un ping pe pool-ul shared (SELECT 1 FROM amef_shared
// .tenants LIMIT 1) — folosit de readiness probe sau pagini de status. Dacă
// DB-ul e inaccesibil returnăm 503 ca probe-urile să poată face triage.
//
// `_deps` permite testelor să injecteze un pool fals fără a porni Cloud SQL.

const express = require('express');
const realPool = require('../db/pool');

// _deps object exported strictly for testing. Tests mutate _deps.pool to
// inject a mock. Production code MUST NOT touch _deps directly except in
// lazy init.
const _deps = {
  pool: realPool,
};

const router = express.Router();

router.get('/', async (req, res) => {
  const checkDb = req.query.check === 'db';
  const base = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  };

  if (!checkDb) {
    return res.status(200).json({ success: true, data: base });
  }

  try {
    const pool = await _deps.pool.getSharedPool();
    // Folosim direct `amef_shared.tenants` (cu schema explicit) ca să
    // verificăm și conectivitatea, și că migrațiile au rulat. LIMIT 1 ca
    // să fie ieftin chiar și pe tabelă mare.
    await pool.query('SELECT 1 FROM amef_shared.tenants LIMIT 1');
    return res
      .status(200)
      .json({ success: true, data: { ...base, db: 'ok' } });
  } catch (err) {
    // Nu aruncăm spre middleware-ul de erori — vrem ca 503 să rămână
    // distinct de un 500 generic, ca probe-urile să-l recunoască.
    if (req.log) {
      req.log.warn({ err }, 'Health DB check eșuat');
    }
    return res.status(503).json({
      success: false,
      error: 'DB indisponibil',
      code: 'DB_UNAVAILABLE',
      data: { ...base, status: 'degraded', db: 'down' },
    });
  }
});

module.exports = router;
module.exports._deps = _deps;
