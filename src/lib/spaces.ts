/** Project Spaces: named working folders, persisted locally, user-ordered. */

export interface ProjectSpace {
  id: string;
  name: string;
  path: string;
}

const KEY = "mcd.spaces";

export function newSpaceId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `space-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
}

function withIds(seed: { name: string; path: string }[]): ProjectSpace[] {
  return seed.map((s) => ({ id: newSpaceId(), name: s.name, path: s.path }));
}

export function loadSpaces(seed: { name: string; path: string }[]): ProjectSpace[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const clean = arr.filter(
          (s) =>
            s &&
            typeof s.id === "string" &&
            typeof s.name === "string" &&
            typeof s.path === "string"
        ) as ProjectSpace[];
        if (clean.length > 0) return clean;
      }
    }
  } catch {
    /* fall through to seed */
  }
  return withIds(seed);
}

export function saveSpaces(spaces: ProjectSpace[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(spaces));
  } catch {
    /* storage unavailable */
  }
}

/** Strip characters that are illegal in folder names on Windows/macOS. */
export function sanitizeSpaceName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").trim();
}
