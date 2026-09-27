import { useEffect, useState } from "react";
import { LOGO_URL } from "../constants";
import { appVersion } from "../lib/version";

/** Total splash lifetime: entrance + hold + fade. Must match splash-life. */
const SPLASH_MS = 3600;

/**
 * Opening splash: black screen, centered logo, "muse (+code)." and the
 * tagline, then fades away. Self-dismissing — the parent just mounts it.
 * The logo resolves through LOGO_URL, so installing the final logo art
 * updates the splash with no code change.
 */
export default function Splash() {
  const [gone, setGone] = useState(false);
  const [ver, setVer] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setGone(true), SPLASH_MS);
    appVersion().then((v) => setVer(v)).catch(() => {});
    return () => clearTimeout(t);
  }, []);
  if (gone) return null;
  return (
    <div className="splash" aria-hidden="true">
      <img src={LOGO_URL} alt="" className="splash-logo" draggable={false} />
      <div className="splash-title">
        muse <span className="splash-code">(+code).</span>
      </div>
      <div className="splash-tag">Inspire then Implement.</div>
      {ver && <div className="splash-ver">v{ver}</div>}
    </div>
  );
}
