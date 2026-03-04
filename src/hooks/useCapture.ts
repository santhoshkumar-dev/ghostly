import { useCallback } from "react";
import { useStore } from "../store/useStore";

export function useCapture() {
  const setCurrentScreenshot = useStore((s) => s.setCurrentScreenshot);
  const setError = useStore((s) => s.setError);

  const captureFullScreen = useCallback(async () => {
    try {
      const base64 = await window.ghostlyAPI.captureScreen();
      setCurrentScreenshot(base64);
      return base64;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to capture screen";
      setError(message);
      return null;
    }
  }, [setCurrentScreenshot, setError]);

  const captureRegion = useCallback(
    async (x: number, y: number, width: number, height: number) => {
      try {
        const base64 = await window.ghostlyAPI.captureRegion(
          x,
          y,
          width,
          height,
        );
        setCurrentScreenshot(base64);
        return base64;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to capture region";
        setError(message);
        return null;
      }
    },
    [setCurrentScreenshot, setError],
  );

  return { captureFullScreen, captureRegion };
}
