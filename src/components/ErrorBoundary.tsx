import React from "react";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  info: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null, info: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[Ghostly] React crashed:", error, info.componentStack);
    this.setState({ error, info });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.95)",
            color: "#ff6b6b",
            fontFamily: "monospace",
            padding: 30,
            fontSize: 13,
            overflow: "auto",
            zIndex: 999999,
            pointerEvents: "auto",
          }}
        >
          <h2 style={{ color: "#fff", fontSize: 16 }}>
            ⚠ Ghostly crashed — React Error
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", color: "#ff6b6b", marginTop: 12 }}>
            {this.state.error?.message}
          </pre>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              color: "#aaa",
              marginTop: 12,
              fontSize: 11,
            }}
          >
            {this.state.info?.componentStack}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20,
              padding: "8px 16px",
              background: "#333",
              color: "#fff",
              border: "1px solid #555",
              borderRadius: 6,
              cursor: "pointer",
              fontFamily: "monospace",
            }}
          >
            Reload App
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
