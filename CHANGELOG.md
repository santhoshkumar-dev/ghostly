# Changelog

## [1.0.1] - 2026-03-07

### Features

- Introduce Home page and a settings panel for managing AI and audio configurations.
- Implement multi-turn chat UI with stealth input and auto-scroll
- Update Groq, Anthropic, OpenAI, and Gemini providers to support multi-turn messages
- Update AIRequestOptions to include messages for chat history
- Add sessionMessages to store for multi-turn chat

### Bug Fixes

- Use opacity for window visibility and ensure mouse interception is disabled when hidden
- Use opacity for window visibility to preserve stealth and fix mouse capture
- Use AbortController to cleanly cancel concurrent AI streams and prevent UI scrambling

### Performance

- Implement sliding window for chat history to prevent context limits
- Skip Prism syntax highlighting during stream to prevent CPU spikes
- Migrate from ScriptProcessor to AudioWorklet to prevent audio dropping

### Refactoring

- Remove isRegionSelecting from global store
- Remove captureRegion IPC handler
- Remove region capture logic
- Remove unused RegionSelector component
