import { FilterGroup } from '../../shared';

// FE-owned: saved HubSpot Search filter builders, persisted in localStorage so
// operators can reuse a common audience definition across campaigns.
const KEY = 'campaigns.savedSearchFilters';

export interface SavedFilter {
  id: string;
  name: string;
  groups: FilterGroup[];
  groupMatch: 'any' | 'all';
}

export function getSavedFilters(): SavedFilter[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function write(list: SavedFilter[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // private mode / quota — ignore
  }
}

// Save (or overwrite a same-named entry). Returns the full updated list.
export function saveFilter(
  name: string,
  groups: FilterGroup[],
  groupMatch: 'any' | 'all'
): { list: SavedFilter[]; saved: SavedFilter } {
  const list = getSavedFilters();
  const existing = list.find(
    (f) => f.name.toLowerCase() === name.toLowerCase()
  );
  const saved: SavedFilter = {
    id: existing?.id ?? `sf_${Date.now()}`,
    name,
    // deep-copy so later edits to the builder don't mutate the stored copy
    groups: JSON.parse(JSON.stringify(groups)),
    groupMatch,
  };
  const next = existing
    ? list.map((f) => (f.id === existing.id ? saved : f))
    : [...list, saved];
  write(next);
  return { list: next, saved };
}

// Overwrite an existing saved filter in place (by id) — supports renaming and
// updating its groups. Returns the updated list (unchanged if the id is gone).
export function updateSavedFilter(
  id: string,
  name: string,
  groups: FilterGroup[],
  groupMatch: 'any' | 'all'
): { list: SavedFilter[]; saved: SavedFilter | null } {
  const list = getSavedFilters();
  const existing = list.find((f) => f.id === id);
  if (!existing) return { list, saved: null };
  const saved: SavedFilter = {
    id,
    name,
    groups: JSON.parse(JSON.stringify(groups)),
    groupMatch,
  };
  const next = list.map((f) => (f.id === id ? saved : f));
  write(next);
  return { list: next, saved };
}

export function deleteFilter(id: string): SavedFilter[] {
  const next = getSavedFilters().filter((f) => f.id !== id);
  write(next);
  return next;
}
