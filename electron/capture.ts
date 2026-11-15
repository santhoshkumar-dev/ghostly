import { desktopCapturer, screen } from "electron";

export async function captureFullScreen(): Promise<string> {
  const cursorPoint = screen.getCursorScreenPoint();
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
  const displays = screen.getAllDisplays();
  const { width, height } = targetDisplay.size;
  const scaleFactor = targetDisplay.scaleFactor;

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

  const matchingSource = sources.find(
    (source) => source.display_id === String(targetDisplay.id),
  );
  const targetDisplayIndex = displays.findIndex(
    (display) => display.id === targetDisplay.id,
  );
  // Some Linux backends expose source IDs that do not match Screen display IDs.
  const source =
    matchingSource ??
    (sources.length === 1
      ? sources[0]
      : sources.length === displays.length && targetDisplayIndex >= 0
        ? sources[targetDisplayIndex]
        : undefined);

  if (!source) {
    throw new Error(
      `Could not find a capture source for display ${targetDisplay.id}. ` +
        `Found ${sources.length} screen sources for ${displays.length} displays.`,
    );
  }

  return source.thumbnail.toDataURL();
}
