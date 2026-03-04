import React, { useEffect } from "react";
import { useStore } from "./store/useStore";
import { Home } from "./pages/Home";
import "./styles/global.css";

const App: React.FC = () => {
  const { setSettings, setHistory } = useStore();

  // Load persisted settings & history on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const [savedSettings, savedHistory] = await Promise.all([
          window.ghostly.getSettings(),
          window.ghostly.getHistory(),
        ]);
        if (savedSettings) setSettings(savedSettings);
        if (savedHistory) setHistory(savedHistory);
      } catch {
        /* first run — use defaults */
      }
    };
    loadData();
  }, [setSettings, setHistory]);

  return <Home />;
};

export default App;
