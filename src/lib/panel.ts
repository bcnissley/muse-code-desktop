import { invoke } from "@tauri-apps/api/core";

export interface MusePanelStatus {
  available: boolean; // side-by-side Muse view is supported/built
  visible: boolean; // currently shown
  split: number; // fraction of window width for the Muse Code side
  code_visible: boolean; // false = Muse Code side collapsed to a slim strip
}

export async function musePanelStatus(): Promise<MusePanelStatus> {
  return invoke("muse_panel_status");
}
export async function setMusePanel(visible: boolean): Promise<MusePanelStatus> {
  return invoke("set_muse_panel", { visible });
}
export async function setMuseCodePanel(visible: boolean): Promise<MusePanelStatus> {
  return invoke("set_muse_code_panel", { visible });
}
export async function setMuseSplit(ratio: number): Promise<MusePanelStatus> {
  return invoke("set_muse_split", { ratio });
}
export async function openMuseUrl(url: string): Promise<void> {
  return invoke("open_muse_url", { url });
}
export async function setMuseUrl(url: string): Promise<MusePanelStatus> {
  return invoke("set_muse_url", { url });
}

/**
 * Open a URL in the app's internal browser window.
 * Contract: links never escape to the OS browser.
 */
export async function openInAppBrowser(url: string): Promise<void> {
  return invoke("open_in_app_browser", { url });
}
