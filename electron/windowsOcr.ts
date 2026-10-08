/**
 * Local OCR via the Windows built-in engine (`Windows.Media.Ocr`), bound
 * directly through `koffi`.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * Live Screen mode has to read text off a screen region without a cloud vision
 * model and without a new npm dependency. Ghostly already depends on `koffi`
 * (`electron/stealth.ts`), so the OCR engine that ships *with Windows* is the
 * smallest possible footprint: no WASM blob, no model download, no training
 * data, nothing to keep in sync.
 *
 * ── Privacy contract ───────────────────────────────────────────────────────
 * This module is a pure function from pixels to text. It never writes a file,
 * never logs pixels or text, and never makes a network call. The only thing
 * that leaves this function is a `string` of recognised text, which the caller
 * is responsible for keeping in memory.
 *
 * ── The ABI this binds ────────────────────────────────────────────────────
 * WinRT is COM with a fixed vtable, so every call is "look up slot N, then call
 * it". Two layout rules drive every index below:
 *
 *   1. Every WinRT interface sits on `IInspectable`, whose vtable is 6 slots:
 *      QueryInterface, AddRef, Release, GetIids, GetRuntimeClassName,
 *      GetTrustLevel. So an interface's first own method is slot 6.
 *   2. An interface's OWN methods come first; the methods it `requires` are
 *      appended after them. (`ISoftwareBitmap.PixelWidth` at slot 8 — two own
 *      methods after BitmapPixelFormat/BitmapAlphaMode — pins this down.)
 *
 * Index constants are named and commented so they can be checked against the
 * IDL rather than guessed at.
 */

import { Buffer } from "node:buffer";

/** BitmapPixelFormat.Bgra8 — what `Electron.NativeImage.toBitmap()` returns. */
const BITMAP_PIXEL_FORMAT_BGRA8 = 87;

/** BitmapAlphaMode.Ignore — OCR reads luminance, so alpha is irrelevant. */
const BITMAP_ALPHA_MODE_IGNORE = 2;

/** BitmapBufferAccessMode.Write — we only push pixels in, never read them out. */
const BITMAP_BUFFER_ACCESS_MODE_WRITE = 2;

/**
 * Refuse absurd input before any WinRT call. The engine's own limit is read at
 * runtime (`get_MaxImageDimension`, 10000 on this machine), but a cheap
 * pre-check keeps a bug from allocating a huge bitmap first.
 */
export const OCR_MAX_DIMENSION = 10_000;

/** Guard on the raw pixel payload so a bad width/height cannot walk off it. */
export const OCR_MAX_BYTES = OCR_MAX_DIMENSION * OCR_MAX_DIMENSION * 4;

/** Upper bound on how long a single recognition may take before we give up. */
const OCR_TIMEOUT_MS = 8_000;

/** Poll interval while waiting on the WinRT async operation. */
const OCR_POLL_INTERVAL_MS = 8;

/** AsyncStatus (Windows.Foundation.AsyncStatus). */
const ASYNC_STATUS_STARTED = 0;
const ASYNC_STATUS_COMPLETED = 1;
const ASYNC_STATUS_CANCELED = 2;
const ASYNC_STATUS_ERROR = 3;

// ── IIDs ────────────────────────────────────────────────────────────────────
// Stable, published WinRT interface identifiers. Only the ones this module
// actually needs are declared.
//
// IAsyncInfo is used to poll completion instead of reading GetResults blindly.
const IID_IASYNC_INFO = "{00000036-0000-0000-c000-000000000046}";
const IID_IOcrEngineStatics = "{5bffa85a-3384-3540-9940-699120d428a8}";
const IID_ISoftwareBitmapFactory = "{c99feb69-2d62-4d47-a6b3-4fdb6a07fdf8}";
const IID_IMemoryBuffer = "{fbc4dd2a-245b-11e4-af98-689423260cf8}";
const IID_IMemoryBufferByteAccess = "{5b0d3235-4dba-4d44-865e-8f1d0e4fd04d}";

/** A COM interface pointer, as koffi hands them back. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ComPtr = any;

// ── Vtable slots ────────────────────────────────────────────────────────────
const VT_RELEASE = 2; // IInspectable.Release
const VT_QUERY_INTERFACE = 0; // IInspectable.QueryInterface

// IAsyncInfo (base 6): get_Id(6), get_Status(7), get_ErrorCode(8),
// Cancel(9), Close(10).
const VT_ASYNC_INFO_STATUS = 7;

// IOcrEngineStatics (base 6 + own methods in IDL order)
const VT_OCR_STATICS_MAX_IMAGE_DIMENSION = 6;
const VT_OCR_STATICS_TRY_CREATE_FROM_USER_PROFILE_LANGUAGES = 10;

// ISoftwareBitmapFactory (base 6): Create(6), CreateWithAlpha(7)
const VT_SOFTWARE_BITMAP_FACTORY_CREATE_WITH_ALPHA = 7;

// ISoftwareBitmap (base 6 + own methods in IDL order):
// BitmapPixelFormat(6), BitmapAlphaMode(7), PixelWidth(8), PixelHeight(9),
// IsReadOnly(10), put_DpiX(11), get_DpiX(12), put_DpiY(13), get_DpiY(14),
// LockBuffer(15), CopyTo(16), CopyFromBuffer(17), CopyToBuffer(18),
// GetReadOnlyView(19)
const VT_SOFTWARE_BITMAP_LOCK_BUFFER = 15;

// IMemoryBuffer: CreateReference(6), then the IInspectable-passthrough slots.
// The bitmap buffer exposes IMemoryBuffer, but the raw pointer is only
// reachable through a reference object — QueryInterface for the byte-access
// interface on the buffer itself fails with E_NOINTERFACE.
const VT_MEMORY_BUFFER_CREATE_REFERENCE = 6;

// IMemoryBufferByteAccess: QI, AddRef, Release, GetBuffer
const VT_MEMORY_BUFFER_BYTE_ACCESS_GET_BUFFER = 3;

// IOcrEngine (base 6): RecognizeAsync(6), get_RecognizerLanguage(7)
const VT_OCR_ENGINE_RECOGNIZE_ASYNC = 6;

// IAsyncOperation<T>: own methods first (put_Completed(6), get_Completed(7),
// GetResults(8)), then the IAsyncInfo methods it requires (get_Id(9),
// get_Status(10), get_ErrorCode(11), Cancel(12), Close(13)).
const VT_ASYNC_OPERATION_GET_RESULTS = 8;

// IOcrResult: get_Lines(6), get_TextAngle(7), get_Text(8)
const VT_OCR_RESULT_GET_TEXT = 8;

// ── Lazily bound native state ───────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let koffi: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let combase: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let memcpy: any = null;

/** True once RoInitialize has run, so we know whether to RoUninitialize. */
let winrtInitialized = false;

/** Set when the machine has no usable OCR language pack. */
let unavailableReason: string | null = null;

/** Cached engine. Creating one walks several COM objects, so it is kept. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let engine: any = null;

/** Cached max image dimension, read once from the engine. */
let maxImageDimension: number | null = null;

/** Thrown by the binding layer; the caller decides how loudly to complain. */
export class OcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OcrUnavailableError";
  }
}

/** Build a 16-byte GUID in the little-endian layout `REFIID` expects. */
function guid(dashed: string): Buffer {
  const hex = dashed.replace(/[{}-]/g, "");
  const out = Buffer.alloc(16);
  // Data1/2/3 are integers stored little-endian; Data4 is copied as written.
  out.writeUInt32LE(parseInt(hex.slice(0, 8), 16), 0);
  out.writeUInt16LE(parseInt(hex.slice(8, 12), 16), 4);
  out.writeUInt16LE(parseInt(hex.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i++) {
    out[8 + i] = parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  }
  return out;
}

/**
 * Bind combase.dll once.
 *
 * Failure here means koffi is unavailable (non-Windows, or a stripped install).
 * That is not fatal — Live Screen simply stays unavailable — so it is reported
 * as a reason string rather than thrown.
 */
function ensureNative(): void {
  if (combase) return;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  koffi = require("koffi");
  combase = koffi.load("combase.dll");
  // memcpy lives in the CRT, not combase.dll.
  memcpy = func(
    "void *memcpy(void *dest, void *src, uint64 count)",
    "msvcrt.dll",
  );

  const RoInitialize = func("int32 __stdcall RoInitialize(int32 initType)");
  // RO_INIT_MULTITHREADED
  const hr = RoInitialize(1);
  // 0 = S_OK, 1 = S_FALSE (already initialised). A negative result here means
  // the thread is already in an incompatible apartment; WinRT still works for
  // our purposes, we just must not call RoUninitialize later.
  winrtInitialized = hr >= 0;
}

/**
 * Stage tracing for the native pipeline. Off unless GHOSTLY_OCR_DEBUG is set,
 * and it names stages only — never pixels, never recognised text.
 */
function trace(stage: string): void {
  if (process.env.GHOSTLY_OCR_DEBUG) {
    console.error(`[ocr] ${stage}`);
  }
}

/**
 * Protos and imported functions are registered by name inside koffi, so
 * declaring the same one twice throws "Duplicate type name". These caches make
 * every signature declare exactly once, no matter how often it is called.
 */
const protoCache = new Map<string, unknown>();
const funcCache = new Map<string, unknown>();

/** Memoised `koffi.proto` — declares `signature` at most once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function proto(signature: string): any {
  let fn = protoCache.get(signature);
  if (!fn) {
    fn = koffi.proto(signature);
    protoCache.set(signature, fn);
  }
  return fn;
}

/** Memoised `library.func` — imports `signature` at most once. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function func(signature: string, library = "combase.dll"): any {
  const key = `${library}:${signature}`;
  let fn = funcCache.get(key);
  if (!fn) {
    fn = koffi.load(library).func(signature);
    funcCache.set(key, fn);
  }
  return fn;
}

/** Slot `index` of `iface`'s vtable, as a function pointer. */
function vtableSlot(iface: ComPtr, index: number): number {
  const vtable = koffi.decode(iface, "void *");
  return koffi.decode(vtable, "void *", index + 1)[index];
}

/** Release a COM reference. Tolerates null so cleanup stays simple. */
function release(iface: ComPtr | null | undefined): void {
  if (!iface) return;
  try {
    const fn = koffi.decode(
      vtableSlot(iface, VT_RELEASE),
      proto("void __stdcall ComRelease(void *self)"),
    );
    fn(iface);
  } catch {
    // Best-effort cleanup; never let teardown mask a real error.
  }
}

/** QueryInterface to another interface on the same object. */
function queryInterface(iface: ComPtr, iid: string): ComPtr {
  const fn = koffi.decode(
    vtableSlot(iface, VT_QUERY_INTERFACE),
    proto(
      "int32 __stdcall ComQueryInterface(void *self, void *iid, _Out_ void **result)",
    ),
  );
  // The JS array is the out-parameter storage koffi writes back into. It is
  // named `result` rather than `out` because koffi treats `out` specially.
  const result = [null];
  const hr = fn(iface, guid(iid), result);
  if (hr !== 0 || !result[0]) {
    throw new OcrUnavailableError(
      `QueryInterface failed (0x${(hr >>> 0).toString(16)})`,
    );
  }
  return result[0];
}

/** Read an HSTRING out-parameter as a JS string. */
function readHString(hstring: ComPtr): string {
  if (!hstring) return "";
  const lenOut = [0];
  const raw = func(
    "str16 __stdcall WindowsGetStringRawBuffer(void *string, _Out_ uint32 *length)",
  );
  return raw(hstring, lenOut) ?? "";
}

/**
 * Free an HSTRING.
 *
 * An HSTRING looks like a COM pointer but is NOT one — it is a string handle
 * owned by the WinRT string runtime. Calling Release() on one corrupts the
 * heap, so this must always be used in its place.
 */
function deleteHString(hstring: ComPtr | null | undefined): void {
  if (!hstring) return;
  try {
    func("void __stdcall WindowsDeleteString(void *string)")(hstring);
  } catch {
    // Best-effort.
  }
}

/**
 * Activate `className` as an IActivationFactory and hand back the activation
 * factory, which is itself a COM object.
 */
function activationFactory(className: string, iid: string): ComPtr {
  const WindowsCreateString = func(
    "int32 __stdcall WindowsCreateString(str16 sourceString, uint32 length, _Out_ void **string)",
  );
  const RoGetActivationFactory = func(
    "int32 __stdcall RoGetActivationFactory(void *classId, void *iid, _Out_ void **factory)",
  );

  const hstring = [null];
  const hrStr = WindowsCreateString(className, className.length, hstring);
  if (hrStr !== 0 || !hstring[0]) {
    throw new OcrUnavailableError(
      `could not build a WinRT class name for ${className}`,
    );
  }

  const factory = [null];
  const hr = RoGetActivationFactory(hstring[0], guid(iid), factory);
  deleteHString(hstring[0]);
  if (hr !== 0 || !factory[0]) {
    throw new OcrUnavailableError(
      `${className} is not available on this system (0x${(hr >>> 0).toString(16)})`,
    );
  }
  return factory[0];
}

/**
 * Create (once) and return the OCR engine for the user's profile languages.
 *
 * Returns null when the machine has no OCR language pack installed, which is a
 * perfectly normal state — OCR is an optional Windows feature.
 */
function getEngine(): ComPtr | null {
  if (engine) return engine;
  if (unavailableReason) return null;

  try {
    const factory = activationFactory(
      "Windows.Media.Ocr.OcrEngine",
      IID_IOcrEngineStatics,
    );
    try {
      const create = koffi.decode(
        vtableSlot(
          factory,
          VT_OCR_STATICS_TRY_CREATE_FROM_USER_PROFILE_LANGUAGES,
        ),
        proto(
          "int32 __stdcall OcrEngineStatics_TryCreateFromUserProfileLanguages(void *self, _Out_ void **engine)",
        ),
      );
      const out = [null];
      const hr = create(factory, out);
      if (hr !== 0 || !out[0]) {
        unavailableReason =
          "no OCR language pack is installed for this user";
        return null;
      }
      engine = out[0];

      // Read the engine's own size limit while the statics object is still
      // alive, so the pre-check matches what the engine will actually accept.
      try {
        const getMax = koffi.decode(
          vtableSlot(factory, VT_OCR_STATICS_MAX_IMAGE_DIMENSION),
          proto(
            "int32 __stdcall OcrEngineStatics_get_MaxImageDimension(void *self, _Out_ uint32 *value)",
          ),
        );
        const maxOut = [0];
        if (getMax(factory, maxOut) === 0 && maxOut[0] > 0) {
          maxImageDimension = maxOut[0];
        }
      } catch {
        // Keep the static default.
      }
    } finally {
      release(factory);
    }

    return engine;
  } catch (err) {
    unavailableReason =
      err instanceof Error ? err.message : "Windows OCR could not start";
    return null;
  }
}

/** The engine's own maximum image dimension, or the static default. */
export function getMaxImageDimension(): number {
  if (maxImageDimension) return maxImageDimension;
  maxImageDimension = OCR_MAX_DIMENSION;
  return maxImageDimension;
}

/**
 * True when local OCR can run on this machine right now.
 *
 * Cheap enough to call from a render loop: after the first call it is a cached
 * boolean, and it never throws.
 */
export function isOcrAvailable(): boolean {
  if (unavailableReason) return false;
  try {
    ensureNative();
    return getEngine() !== null;
  } catch {
    return false;
  }
}

/** Why OCR is unavailable, for the diagnostic panel. Null when it is. */
export function getUnavailableReason(): string | null {
  isOcrAvailable();
  return unavailableReason;
}

/**
 * Wait for a WinRT IAsyncOperation to finish and return its result pointer.
 *
 * Polls IAsyncInfo.get_Status rather than reading the result slot early,
 * because GetResults on an unfinished operation is undefined behaviour.
 */
function awaitOperation(asyncOp: ComPtr): ComPtr {
  const info = queryInterface(asyncOp, IID_IASYNC_INFO);
  try {
    const getStatus = koffi.decode(
      vtableSlot(info, VT_ASYNC_INFO_STATUS),
      proto(
        "int32 __stdcall IAsyncInfo_get_Status(void *self, _Out_ int32 *status)",
      ),
    );

    const deadline = Date.now() + OCR_TIMEOUT_MS;
    for (;;) {
      const statusOut = [ASYNC_STATUS_STARTED];
      const hr = getStatus(info, statusOut);
      if (hr !== 0) {
        throw new OcrUnavailableError(
          `recognition status query failed (0x${hr >>> 0})`,
        );
      }
      if (statusOut[0] === ASYNC_STATUS_COMPLETED) break;
      if (statusOut[0] === ASYNC_STATUS_CANCELED) return null;
      if (statusOut[0] === ASYNC_STATUS_ERROR) {
        throw new OcrUnavailableError("the Windows OCR engine reported an error");
      }
      if (Date.now() > deadline) {
        throw new OcrUnavailableError("recognition timed out");
      }
      // Busy-wait briefly. OCR is a short, CPU-bound operation and this runs
      // well below the 2s live-screen cadence, so yielding to a timer would
      // only add latency.
      const until = Date.now() + OCR_POLL_INTERVAL_MS;
      while (Date.now() < until) {
        /* spin briefly */
      }
    }
  } finally {
    release(info);
  }

  const getResults = koffi.decode(
    vtableSlot(asyncOp, VT_ASYNC_OPERATION_GET_RESULTS),
    proto(
      "int32 __stdcall IAsyncOperation_GetResults(void *self, _Out_ void **result)",
    ),
  );
  const result = [null];
  const hr = getResults(asyncOp, result);
  if (hr !== 0 || !result[0]) {
    throw new OcrUnavailableError(
      `recognition produced no result (0x${hr >>> 0})`,
    );
  }
  return result[0];
}

/**
 * Recognise text in a raw BGRA pixel buffer.
 *
 * The buffer must be exactly `width * height * 4` bytes in BGRA order, which is
 * what `NativeImage.toBitmap()` produces. Nothing is written to disk and the
 * pixels never leave this function.
 *
 * @returns the recognised text, or `""` when the region held no text.
 * @throws OcrUnavailableError when OCR is unavailable or the frame is invalid.
 */
export function recognizeBgraSync(
  bgra: Buffer,
  width: number,
  height: number,
): string {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new OcrUnavailableError("frame dimensions must be integers");
  }
  if (width <= 0 || height <= 0) {
    throw new OcrUnavailableError("frame dimensions must be positive");
  }
  if (width > OCR_MAX_DIMENSION || height > OCR_MAX_DIMENSION) {
    throw new OcrUnavailableError(
      `frame ${width}x${height} exceeds the ${OCR_MAX_DIMENSION}px OCR limit`,
    );
  }
  const expected = width * height * 4;
  if (bgra.length !== expected) {
    throw new OcrUnavailableError(
      `expected ${expected} bytes of BGRA, received ${bgra.length}`,
    );
  }

  ensureNative();
  const activeEngine = getEngine();
  if (!activeEngine) {
    throw new OcrUnavailableError(
      unavailableReason ?? "Windows OCR is unavailable",
    );
  }

  // 1. Allocate a BGRA SoftwareBitmap of exactly this size.
  const bitmapFactory = activationFactory(
    "Windows.Graphics.Imaging.SoftwareBitmap",
    IID_ISoftwareBitmapFactory,
  );
  let bitmap: ComPtr | null = null;
  try {
    const create = koffi.decode(
      vtableSlot(bitmapFactory, VT_SOFTWARE_BITMAP_FACTORY_CREATE_WITH_ALPHA),
      proto(
        "int32 __stdcall SoftwareBitmapFactory_CreateWithAlpha(void *self, int32 format, int32 width, int32 height, int32 alpha, _Out_ void **value)",
      ),
    );
    const bitmapOut = [null];
    const hrCreate = create(
      bitmapFactory,
      BITMAP_PIXEL_FORMAT_BGRA8,
      width,
      height,
      BITMAP_ALPHA_MODE_IGNORE,
      bitmapOut,
    );
    if (hrCreate !== 0 || !bitmapOut[0]) {
      throw new OcrUnavailableError(
        `could not allocate a ${width}x${height} bitmap (0x${(hrCreate >>> 0).toString(16)})`,
      );
    }
    bitmap = bitmapOut[0];

    // 2. Lock it for writing and copy the pixels straight in.
    const lock = koffi.decode(
      vtableSlot(bitmap, VT_SOFTWARE_BITMAP_LOCK_BUFFER),
      proto(
        "int32 __stdcall SoftwareBitmap_LockBuffer(void *self, int32 mode, _Out_ void **value)",
      ),
    );
    const bitmapBuffer = [null];
    const hrLock = lock(bitmap, BITMAP_BUFFER_ACCESS_MODE_WRITE, bitmapBuffer);
    if (hrLock !== 0 || !bitmapBuffer[0]) {
      throw new OcrUnavailableError(
        `could not lock the bitmap for writing (0x${(hrLock >>> 0).toString(16)})`,
      );
    }

    try {
      // BitmapBuffer -> IMemoryBuffer -> CreateReference -> raw pointer.
      const memoryBuffer = queryInterface(bitmapBuffer[0], IID_IMemoryBuffer);
      let reference: ComPtr | null = null;
      try {
        const createReference = koffi.decode(
          vtableSlot(memoryBuffer, VT_MEMORY_BUFFER_CREATE_REFERENCE),
          proto(
            "int32 __stdcall IMemoryBuffer_CreateReference(void *self, _Out_ void **value)",
          ),
        );
        const referenceOut = [null];
        const hrReference = createReference(memoryBuffer, referenceOut);
        if (hrReference !== 0 || !referenceOut[0]) {
          throw new OcrUnavailableError(
            `could not reference the bitmap buffer (0x${(hrReference >>> 0).toString(16)})`,
          );
        }
        reference = referenceOut[0];
      } finally {
        release(memoryBuffer);
      }

      try {
        const byteAccess = queryInterface(reference, IID_IMemoryBufferByteAccess);
        try {
          const getBuffer = koffi.decode(
            vtableSlot(byteAccess, VT_MEMORY_BUFFER_BYTE_ACCESS_GET_BUFFER),
            proto(
              "int32 __stdcall IMemoryBufferByteAccess_GetBuffer(void *self, _Out_ void **bytes, _Out_ uint32 *size)",
            ),
          );
          const bytesOut = [null];
          const sizeOut = [0];
          const hrGet = getBuffer(byteAccess, bytesOut, sizeOut);
          if (hrGet !== 0 || !bytesOut[0]) {
            throw new OcrUnavailableError(
              `could not obtain the bitmap pixels (0x${(hrGet >>> 0).toString(16)})`,
            );
          }
          // The bitmap's stride is width*4 with no padding for a BGRA bitmap
          // of this kind; the size check makes that assumption explicit rather
          // than letting a short copy corrupt memory.
          if (sizeOut[0] < expected) {
            throw new OcrUnavailableError(
              `bitmap buffer is ${sizeOut[0]} bytes, need ${expected}`,
            );
          }
          memcpy(bytesOut[0], bgra, expected);
          trace("pixels copied into the SoftwareBitmap");
        } finally {
          release(byteAccess);
        }
      } finally {
        release(reference);
      }
    } finally {
      release(bitmapBuffer[0]);
    }

    // 3. Recognise, and read the text off the result.
    const recognize = koffi.decode(
      vtableSlot(activeEngine, VT_OCR_ENGINE_RECOGNIZE_ASYNC),
      proto(
        "int32 __stdcall OcrEngine_RecognizeAsync(void *self, void *bitmap, _Out_ void **operation)",
      ),
    );
    const opOut = [null];
    const hrRecognize = recognize(activeEngine, bitmap, opOut);
    if (hrRecognize !== 0 || !opOut[0]) {
      throw new OcrUnavailableError(
        `recognition could not start (0x${(hrRecognize >>> 0).toString(16)})`,
      );
    }

    let result: ComPtr | null = null;
    let text: ComPtr | null = null;
    try {
      trace("recognition started, awaiting completion");
      result = awaitOperation(opOut[0]);
      trace(`recognition finished (result=${result ? "yes" : "null"})`);
      if (!result) return "";
      const getText = koffi.decode(
        vtableSlot(result, VT_OCR_RESULT_GET_TEXT),
        proto("int32 __stdcall OcrResult_get_Text(void *self, _Out_ void **value)"),
      );
      const textOut = [null];
      const hrText = getText(result, textOut);
      trace(`get_Text -> 0x${(hrText >>> 0).toString(16)}`);
      if (hrText !== 0) return "";
      text = textOut[0];
      const value = readHString(text);
      trace(`read ${value.length} characters`);
      return value;
    } finally {
      deleteHString(text);
      release(result);
      release(opOut[0]);
    }
  } finally {
    release(bitmap);
    release(bitmapFactory);
  }
}

/**
 * Async wrapper. The underlying work is synchronous and CPU-bound, so this
 * defers it a tick to keep the caller's frame loop responsive rather than
 * pretending it is concurrent.
 */
export async function recognizeBgra(
  bgra: Buffer,
  width: number,
  height: number,
): Promise<string> {
  return recognizeBgraSync(bgra, width, height);
}