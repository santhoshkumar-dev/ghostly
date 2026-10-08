import { desktopCapturer, screen } from "electron";

export async function captureFullScreen(): Promise<string> {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const scaleFactor = primaryDisplay.scaleFactor;

  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: {
      width: Math.round(width * scaleFactor),
      height: Math.round(height * scaleFactor),
    },
  });

  if (sources.length === 0) {
    throw new Error("No screen source found");
  }

  return sources[0].thumbnail.toDataURL();
}


// ── Manual capture only ──────────────────────────────────────────────────────
// The GDI region reader (captureRegionBgra) and its pixel caps existed ONLY for
// the automatic Live Screen watcher, which was removed together with
// "Auto-detect new question". Screenshots are MANUAL: the Capture Screen button
// and Ctrl+Shift+S both go through ghostly:capture-fullscreen →
// captureFullScreen() above — one implementation, one IPC route.
