import React, { useState, useCallback, useEffect, useRef } from "react";
import { motion } from "framer-motion";

interface RegionSelectorProps {
  onRegionSelected: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => void;
  onCancel: () => void;
}

export const RegionSelector: React.FC<RegionSelectorProps> = ({
  onRegionSelected,
  onCancel,
}) => {
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPoint, setStartPoint] = useState({ x: 0, y: 0 });
  const [currentPoint, setCurrentPoint] = useState({ x: 0, y: 0 });
  const overlayRef = useRef<HTMLDivElement>(null);

  const getRect = useCallback(() => {
    const x = Math.min(startPoint.x, currentPoint.x);
    const y = Math.min(startPoint.y, currentPoint.y);
    const width = Math.abs(currentPoint.x - startPoint.x);
    const height = Math.abs(currentPoint.y - startPoint.y);
    return { x, y, width, height };
  }, [startPoint, currentPoint]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    setIsDrawing(true);
    setStartPoint({ x: e.clientX, y: e.clientY });
    setCurrentPoint({ x: e.clientX, y: e.clientY });
  }, []);

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDrawing) return;
      setCurrentPoint({ x: e.clientX, y: e.clientY });
    },
    [isDrawing],
  );

  const handleMouseUp = useCallback(() => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const rect = getRect();
    if (rect.width > 10 && rect.height > 10) {
      onRegionSelected(rect.x, rect.y, rect.width, rect.height);
    }
  }, [isDrawing, getRect, onRegionSelected]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  const rect = getRect();

  return (
    <motion.div
      ref={overlayRef}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[9999] cursor-crosshair"
      style={{ background: "rgba(0, 0, 0, 0.3)" }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
    >
      {/* Instructions */}
      <div className="absolute top-8 left-1/2 -translate-x-1/2 px-6 py-3 rounded-xl glass">
        <p className="text-sm text-dark-200 font-medium text-center">
          🎯 Click and drag to select a region · Press{" "}
          <kbd className="px-1.5 py-0.5 rounded bg-dark-700 text-xs font-mono">
            ESC
          </kbd>{" "}
          to cancel
        </p>
      </div>

      {/* Selection rectangle */}
      {isDrawing && rect.width > 0 && rect.height > 0 && (
        <>
          {/* Clear area inside selection */}
          <div
            className="absolute border-2 border-ghostly-400 rounded-sm"
            style={{
              left: rect.x,
              top: rect.y,
              width: rect.width,
              height: rect.height,
              background: "rgba(76, 110, 245, 0.08)",
              boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.4)",
            }}
          >
            {/* Corner handles */}
            <div className="absolute -top-1 -left-1 w-2.5 h-2.5 bg-ghostly-400 rounded-full" />
            <div className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-ghostly-400 rounded-full" />
            <div className="absolute -bottom-1 -left-1 w-2.5 h-2.5 bg-ghostly-400 rounded-full" />
            <div className="absolute -bottom-1 -right-1 w-2.5 h-2.5 bg-ghostly-400 rounded-full" />
          </div>

          {/* Dimension label */}
          <div
            className="absolute px-2 py-1 rounded bg-dark-900/90 text-xs text-dark-300 font-mono"
            style={{
              left: rect.x + rect.width / 2 - 30,
              top: rect.y + rect.height + 8,
            }}
          >
            {Math.round(rect.width)} × {Math.round(rect.height)}
          </div>
        </>
      )}
    </motion.div>
  );
};
