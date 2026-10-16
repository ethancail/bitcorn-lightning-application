// Copy text to the clipboard on any origin. navigator.clipboard exists only
// in secure contexts, and members reach their node over plain HTTP on a
// Tailscale or LAN IP, so the hidden-textarea + execCommand("copy") fallback
// is the common path. Pattern: stablecoin/components/EmptyState.tsx (#341).
//
// Resolves true only when one of the two paths actually copied, so a caller's
// "Copied" feedback never claims a copy that didn't happen.
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through
    }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.appendChild(ta); ta.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
