/**
 * Terminal QR rendering.
 *
 * qrcode-terminal's `small` mode uses half-block characters (▀▄), which many
 * Windows console fonts render with gaps, making the code unscannable.
 * Default to full-size blocks on Windows; override with WAI_QR_SMALL=1 / 0.
 */
function useSmallQr(): boolean {
  const env = process.env.WAI_QR_SMALL;
  if (env === "1" || env === "true") return true;
  if (env === "0" || env === "false") return false;
  return process.platform !== "win32";
}

/** Render text as a terminal QR code. Returns null if qrcode-terminal is unavailable. */
export async function renderQr(text: string): Promise<string | null> {
  try {
    const qrTerminal = await import("qrcode-terminal");
    // Call as a method: generate() reads this.error internally
    const qrt = (qrTerminal.default || qrTerminal) as any;
    let output = "";
    qrt.generate(text, { small: useSmallQr() }, (out: string) => {
      output = out;
    });
    return output;
  } catch {
    return null;
  }
}
