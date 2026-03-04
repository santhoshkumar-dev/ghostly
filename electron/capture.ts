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

export async function captureRegion(
  x: number,
  y: number,
  regionWidth: number,
  regionHeight: number,
): Promise<string> {
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

  const fullScreenshot = sources[0].thumbnail;

  const cropped = fullScreenshot.crop({
    x: Math.round(x * scaleFactor),
    y: Math.round(y * scaleFactor),
    width: Math.round(regionWidth * scaleFactor),
    height: Math.round(regionHeight * scaleFactor),
  });

  return cropped.toDataURL();
}
