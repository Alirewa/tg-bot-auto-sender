import { SubsRepo } from '../database/repositories';

// Dynamic source list — admin manages it via /addsub /delsub /listsubs.
// Seeded with two default URLs on first DB migration (see database/migrations.ts).
export function getActiveSourceUrls(): string[] {
  return SubsRepo.listEnabled().map((s) => s.url);
}
