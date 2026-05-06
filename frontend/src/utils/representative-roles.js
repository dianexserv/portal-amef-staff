// Lista de roluri reprezentant legal.
//
// Hardcoded până la Stage 12 (Dashboard Configurare Tenant) când va exista
// endpoint-ul `GET /api/v1/admin/representative-roles` și aceste valori vor
// fi citite dinamic din DB. Stage 5e folosește seed-urile din migrația
// 001_init_tenant_schema.sql ca să nu blocăm UI-ul de un endpoint încă neimplementat.
//
// TODO Stage 12: înlocuiește această constantă cu un fetch dinamic + cache
// (rolurile sunt configurate per tenant și editabile din Dashboard).

export const REPRESENTATIVE_ROLES = [
  { id: 1, name: 'Administrator' },
  { id: 2, name: 'Asociat unic' },
  { id: 3, name: 'PFA - titular' },
  { id: 4, name: 'ÎI - titular' },
  { id: 5, name: 'Director General' },
  { id: 6, name: 'Reprezentant împuternicit' },
];

export function getRepresentativeRoleName(id) {
  const role = REPRESENTATIVE_ROLES.find((r) => r.id === id);
  return role ? role.name : null;
}
