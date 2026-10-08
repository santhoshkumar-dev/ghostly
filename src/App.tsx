import React, { useEffect } from "react";
import { useStore } from "./store/useStore";
import type { ProviderName } from "./lib/ai";
import { PROVIDER_NAMES, isProviderName } from "./lib/ai";
import {
  isOpenRouterFreeModel,
  OPENROUTER_FREE_MODEL,
} from "./lib/ai/openrouter";
import {
  describeProviderChain,
  normalizeProviderOrder,
  INTERVIEW_PROVIDER_ORDER,
  OPTIONAL_PROVIDER_ORDER,
} from "./lib/providerDiagnostics";
import { Home } from "./pages/Home";
import "./styles/global.css";

/**
 * Bumped whenever the DEFAULT interview chain changes in a way that must be
 * applied to an existing store. Persisted in settings so a migration runs
 * exactly once; without it, a migration would either re-run forever or silently
 * undo a choice the user has since made.
 */
const CURRENT_CHAIN_POLICY_VERSION = 2;

const App: React.FC = () => {
  const { setSettings, setHistory } = useStore();

  // Load persisted settings & history on mount
  useEffect(() => {
    const loadData = async () => {
      if (!window.ghostly) {
        console.warn("[Ghostly] window.ghostly missing — skipping settings load (browser?)");
        return;
      }
      try {
        const [savedSettings, savedHistory] = await Promise.all([
          window.ghostly.getSettings(),
          window.ghostly.getHistory(),
        ]);
        if (savedSettings) {
          // Sanitize — ensure required fields exist and are valid
          const defaults = useStore.getState().settings;

          // The single shared `activeModel` is gone: with provider failover each
          // provider owns its model, so a Groq id can never be written into the
          // Gemini slot (or the reverse).
          const { activeModel: legacyModel, ...rest } = savedSettings as any;
          const activeProvider: ProviderName = isProviderName(
            rest.activeProvider,
          )
            ? rest.activeProvider
            : defaults.activeProvider;

          // Iterate the REGISTRY, not a hardcoded array. The previous literal
          // list omitted "openrouter", so a saved `models.openrouter` choice was
          // discarded on every launch and reset to the default.
          const savedModels = (rest.models ?? {}) as Record<string, unknown>;
          const models = { ...defaults.models };
          for (const p of PROVIDER_NAMES) {
            const saved = savedModels[p];
            models[p] =
              typeof saved === "string" && saved.trim()
                ? saved
                : defaults.models[p];
          }
          // Migrate whatever the old field held into the provider it belonged to.
          if (typeof legacyModel === "string" && legacyModel.trim()) {
            models[activeProvider] = legacyModel;
          }

          // ── Migration: move OpenRouter to the free router ───────────────
          // Earlier builds shipped `openai/gpt-oss-120b` as the OpenRouter
          // default, so a store written then pins us to one model that may be
          // unavailable or rate-limited. The free ROUTER removes that single
          // point of failure, but it is only a *default* — an explicit user
          // choice of any other model is preserved.
          if (
            typeof savedModels.openrouter === "string" &&
            savedModels.openrouter.trim() &&
            savedModels.openrouter !== defaults.models.openrouter &&
            savedModels.openrouter === "openai/gpt-oss-120b"
          ) {
            models.openrouter = OPENROUTER_FREE_MODEL;
            console.warn(
              `[Ghostly] settings migration — OpenRouter model "${savedModels.openrouter}" → "${OPENROUTER_FREE_MODEL}" (free router picks a model per request).`,
            );
          }

          // ── Migration: retired Gemini model ids ───────────────────────
          // Measured against the live API: `gemini-2.5-flash-lite` (and the
          // 2.0 / 1.5 family the old curated list offered) now answer HTTP 404
          // — Google's own message says "no longer available to new users,
          // please update to gemini-3.5-flash-lite". A saved 404 id means every
          // Gemini attempt fails before the first token, so it is replaced ONCE,
          // loudly, with the verified default (`gemini-2.5-flash`, first text
          // measured at 1.2–1.4s through the app's exact streaming path).
          const RETIRED_GEMINI_MODELS = new Set([
            "gemini-2.5-flash-lite",
            "gemini-2.0-flash",
            "gemini-2.0-flash-lite",
            "gemini-1.5-pro",
            "gemini-1.5-flash",
          ]);
          if (
            typeof savedModels.gemini === "string" &&
            RETIRED_GEMINI_MODELS.has(savedModels.gemini)
          ) {
            models.gemini = defaults.models.gemini;
            console.warn(
              `[Ghostly] settings migration — Gemini model "${savedModels.gemini}" is retired (HTTP 404) → "${defaults.models.gemini}".`,
            );
          }

          const savedOrder = Array.isArray(rest.providerOrder)
            ? rest.providerOrder.filter(isProviderName)
            : [];

          // The ASR engine is now Moonshine (transformers.js v3), so a saved
          // `Xenova/whisper-*` id is no longer offered in Settings — migrate it.
          const asrModel =
            typeof rest.whisperModel === "string" &&
            rest.whisperModel.startsWith("onnx-community/")
              ? rest.whisperModel
              : defaults.whisperModel;

          const apiKeys = { ...defaults.apiKeys, ...rest.apiKeys };

          // ── Migration: the old General-mode instruction box ────────────
          //
          // `customInstructions` was the free-text box the old "General" mode
          // showed under the overlay. That whole workflow is gone: there is one
          // mode now, and one instructions field. Rather than dropping what a
          // user had typed into it, it is folded into `answerInstructions` —
          // which is where they would have put it under the new UI anyway — and
          // the old key is removed from the object so there is only ever ONE
          // instruction mechanism. An explicit `answerInstructions` value wins,
          // because it is the newer field and the one the user can still edit.
          const legacyCustom = (rest as { customInstructions?: unknown })
            .customInstructions;
          delete (rest as { customInstructions?: unknown }).customInstructions;
          if (
            typeof legacyCustom === "string" &&
            legacyCustom.trim() &&
            !(typeof rest.answerInstructions === "string" && rest.answerInstructions.trim())
          ) {
            rest.answerInstructions = legacyCustom.trim();
            console.warn(
              "[Ghostly] settings migration — the old General custom instructions were moved into Answer Instructions.",
            );
          }

          // ── Migration: full OpenRouter-led chain ──
          // A store written before the gateway migration can still carry a
          // legacy direct-provider order such as ["groq", "gemini"]. That order
          // is perfectly valid once reloaded, so it survived every previous
          // sanitisation and live answers kept going straight to Groq/Gemini
          // while the UI reported OpenRouter as configured.
          //
          // `normalizeProviderOrder` re-expresses the whole documented chain
          // (OpenRouter → Groq → NVIDIA → Gemini), putting OpenRouter first
          // whenever it has a key and adding every other provider that does.
          // Anything it changes is logged, never silent.
          // ── One-time migration: optional providers leave the chain ────────
          //
          // `normalizeProviderOrder` deliberately RETAINS an optional provider
          // if the saved order already had it, so that a deliberate opt-in
          // survives a restart. But a store written by an older build had
          // Groq and NVIDIA force-added into `providerOrder` by the previous
          // normalizer, not chosen by anyone — and NVIDIA in particular fails
          // with a 404 on the model and a CORS failure on the model listing on
          // every call. Leaving them in would mean every interview still pays a
          // wasted attempt for a provider that cannot answer.
          //
          // So they are removed ONCE, loudly, and can be re-added in Settings.
          // The version guard is what makes this one-time rather than a
          // permanent fight with the user: after this runs, adding NVIDIA back
          // is a choice that is then preserved like any other.
          const chainPolicyVersion =
            typeof rest.chainPolicyVersion === "number"
              ? rest.chainPolicyVersion
              : 0;
          let migratedOrder = savedOrder;
          if (chainPolicyVersion < CURRENT_CHAIN_POLICY_VERSION) {
            const dropped = savedOrder.filter((p: ProviderName) =>
              OPTIONAL_PROVIDER_ORDER.includes(p),
            );
            if (dropped.length > 0) {
              migratedOrder = savedOrder.filter(
                (p: ProviderName) => !OPTIONAL_PROVIDER_ORDER.includes(p),
              );
              console.warn(
                `[Ghostly] settings migration — removed optional providers from the interview chain: ${dropped.join(", ")}. ` +
                  `The default chain is ${INTERVIEW_PROVIDER_ORDER.join(" → ")}; add them back in Settings if you want them.`,
              );
            }
          }

          const providerOrder = normalizeProviderOrder(
            migratedOrder.length > 0
              ? migratedOrder
              : defaults.providerOrder,
            apiKeys,
          );
          if (
            savedOrder.length > 0 &&
            providerOrder.join(",") !== savedOrder.join(",")
          ) {
            console.warn(
              `[Ghostly] settings migration — providerOrder [${savedOrder.join(", ")}] → [${providerOrder.join(", ")}]`,
            );
          }

          const nextSettings = {
            ...defaults,
            ...rest,
            activeProvider,
            models,
            providerOrder,
            apiKeys,
            whisperModel: asrModel,
            chainPolicyVersion: CURRENT_CHAIN_POLICY_VERSION,
          };
          setSettings(nextSettings);

          // Print the whole chain plus the reason every provider is used or
          // skipped. Makes "Groq didn't answer" immediately explainable instead
          // of looking like broken provider architecture.
          for (const line of describeProviderChain(nextSettings).lines) {
            console.log(line);
          }
        }
        if (savedHistory) setHistory(savedHistory);
      } catch (err) {
        console.warn("[Ghostly] Failed to load settings:", err);
      }
    };
    loadData();
  }, [setSettings, setHistory]);

  return <Home />;
};

export default App;
