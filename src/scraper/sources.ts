import { SubsRepo } from '../database/repositories';

export interface Source {
  id: number;
  url: string;
}

// Dynamic source list — admin manages it via /addsub /delsub /listsubs.
export function getActiveSources(): Source[] {
  return SubsRepo.listEnabled().map((s) => ({ id: s.id, url: s.url }));
}

export function getActiveSourceUrls(): string[] {
  return getActiveSources().map((s) => s.url);
}
