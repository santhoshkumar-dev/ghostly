# ASR benchmark fixtures (LOCAL ONLY)

This directory holds the corpus for the Moonshine vs Parakeet vs Groq Whisper
benchmark. **The audio clips in this directory are never committed to Git.**

## Why the clips are not in the repository

These are recordings of a real person's voice. `.gitignore` excludes `*.wav`
globally (added for the dev-only debug WAV dump in `src/lib/debugWav.ts`), and
that rule is intentionally left in place. Only `manifest.json` and this README
are tracked.

Consequence: **a fresh clone has no audio.** The benchmark detects this and
skips cleanly with an explanatory message. It never fabricates a transcript or
invents a WER number.

## What is expected here

15 question clips plus 3 short-segment clips, all **16 kHz, mono, 16-bit PCM
WAV**:

| File | Spoken reference |
|---|---|
| `q01.wav` | Why do we use MongoDB? |
| `q02.wav` | What is Spring Boot? |
| `q03.wav` | Explain Docker. |
| `q04.wav` | What is dependency injection in Spring Boot? |
| `q05.wav` | How does JWT authentication work? |
| `q06.wav` | What is the difference between RabbitMQ and Kafka? |
| `q07.wav` | What is the difference between horizontal scaling and vertical scaling? |
| `q08.wav` | What is the role of Redis in a backend application? |
| `q09.wav` | How would you investigate a 500 error in production? |
| `q10.wav` | Your payment service starts failing immediately after deployment. What would you check first? |
| `q11.wav` | Suppose your application receives thousands of requests at the same time. How would you scale the backend? |
| `q12.wav` | What is Kubernetes? |
| `q13.wav` | What is Terraform used for? |
| `q14.wav` | Tell me about the architecture of your project. |
| `q15.wav` | Why did you choose MongoDB? |
| `s01.wav` | Why not? *(short, target < 1 s)* |
| `s02.wav` | What is Redis? *(short, target ~1–2 s)* |
| `s03.wav` | Explain the indexing strategy. *(short, target ~2–3 s)* |

`manifest.json` is the authoritative source for these filenames and the exact
spoken reference. If you change what you actually say, update the
`reference` field to match **verbatim** — a WER computed against a rewritten
reference is meaningless.

## Recording requirements

- One clip per question, no editing, no trimming of words.
- Record the interviewer-style delivery; awkward pacing is fine, cuts are not.
- Keep the microphone in the position it will actually be used in.
- **No noise reduction or normalisation.** The benchmark must measure the
  engine, not a cleaned-up signal.
- Avoid clipping: if a take distorts, re-record rather than lower the gain
  afterwards.

### Converting to the required format

If your recorder produces 44.1/48 kHz or stereo, convert with ffmpeg:

```bash
ffmpeg -i raw/q01.m4a -ar 16000 -ac 1 -c:a pcm_s16le q01.wav
```

## Verifying a clip before benchmarking

```bash
node scripts/asr-bench.mjs --check
```

This prints each clip's sample rate, channel count and duration, and flags any
clip that is not 16 kHz mono. Fix non-conforming clips before recording the
rest — the engines must all receive identical audio.

## Running the benchmark

```bash
node scripts/asr-bench.mjs            # Moonshine-equivalent + Parakeet (+ Groq if keyed)
node scripts/asr-bench.mjs --padding  # short-segment padding comparison
```

Groq Whisper runs only when `GROQ_API_KEY` is present in the process
environment. The key is read from the environment only; it is never written to
disk, never logged, and never sent to the renderer.

## Synthetic fixtures

For latency / RTF / RAM work before real recordings exist:

```bash
node scripts/generate-synthetic-fixtures.mjs
```

Those are Windows TTS voices, not a human. They are valid for **timing and
memory only** and every output line produced from them is labelled
`synthetic: latency/RAM only, not valid for accuracy`. They are written to
`tests/fixtures/asr/synthetic/` (also gitignored).