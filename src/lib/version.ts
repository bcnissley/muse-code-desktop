import { getVersion } from "@tauri-apps/api/app";

let cached: Promise<string> | null = null;

/** App version from the Tauri bundle (falls back to "dev" under Vite). */
export function appVersion(): Promise<string> {
  if (!cached) cached = getVersion().catch(() => "dev");
  return cached;
}
