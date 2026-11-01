/**
 * What a node can run, pinned by hash, and whether it fits this machine.
 *
 * Runtime: the official llama.cpp build from github.com/ggml-org/llama.cpp, pinned to one release with each archive's
 * sha256 (GitHub's published asset digest). The desktop app refuses any download whose hash differs.
 * Models: open-weight GGUF files pinned to an exact Hugging Face commit and sha256, plus (later) Delphi's own models
 * from the on-chain ModelRegistry, whose sha256 lives on chain. To update: scripts/inference/pin.mjs prints fresh pins.
 */
const GiB = 1024 ** 3;

export const RUNTIME_TAG = "b12032";
const GH = `https://github.com/ggml-org/llama.cpp/releases/download/${RUNTIME_TAG}`;

export type RuntimeAsset = { file: string; size: number; sha256: string };
export type RuntimeBuild = {
  id: string;
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  backend: "cuda" | "vulkan" | "metal" | "cpu";
  /** extracted into one folder; the first holds llama-server, the rest are libraries it needs (e.g. CUDA runtime) */
  assets: RuntimeAsset[];
};

export const runtimeUrl = (a: RuntimeAsset) => `${GH}/${a.file}`;

export const RUNTIMES: RuntimeBuild[] = [
  { id: "win-cuda-x64", os: "windows", arch: "x64", backend: "cuda", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-win-cuda-12.4-x64.zip`, size: 279952566, sha256: "36c7e24ad048cceabf00c1b49d0f0411b954c6a410a7ff4300af8721a94fd00a" },
    { file: "cudart-llama-bin-win-cuda-12.4-x64.zip", size: 391443627, sha256: "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6" },
  ] },
  { id: "win-vulkan-x64", os: "windows", arch: "x64", backend: "vulkan", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-win-vulkan-x64.zip`, size: 37523450, sha256: "19a8bbf269fa683ae7bc04f886c9c2a93e0655c2606f37d2b60069bf9e8bcc32" },
  ] },
  { id: "win-cpu-x64", os: "windows", arch: "x64", backend: "cpu", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-win-cpu-x64.zip`, size: 24582754, sha256: "5296f5d18bb7d422c7c26f4bb9bc796d9d4f41e1312a8c296cff475bdc60d0d4" },
  ] },
  { id: "win-vulkan-arm64", os: "windows", arch: "arm64", backend: "vulkan", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-win-vulkan-arm64.zip`, size: 25601869, sha256: "b51bab79eae616bddeafea6b943ce74305390be400694dfc713036a6b8e1052e" },
  ] },
  { id: "win-cpu-arm64", os: "windows", arch: "arm64", backend: "cpu", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-win-cpu-arm64.zip`, size: 13076167, sha256: "1ecd1087e3cb4a7eee62a4eed4f1b8715a063c1021ce9e6db91b50d1584ebf08" },
  ] },
  { id: "macos-arm64", os: "macos", arch: "arm64", backend: "metal", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-macos-arm64.tar.gz`, size: 16513842, sha256: "00468fe833eb000b78a748122f5921b6c7b07dc82331a8d0c68196c69cb26382" },
  ] },
  { id: "macos-x64", os: "macos", arch: "x64", backend: "cpu", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-macos-x64.tar.gz`, size: 12258802, sha256: "291d99f3b6f45f67f73afe5381540f29928840a1a14d9c19d6595bd649a035fc" },
  ] },
  { id: "linux-vulkan-x64", os: "linux", arch: "x64", backend: "vulkan", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-ubuntu-vulkan-x64.tar.gz`, size: 35669614, sha256: "f75e7107f9450034c5467492c41e9ed91816e2d815fc4b802c6bd58de7d5b126" },
  ] },
  { id: "linux-cpu-x64", os: "linux", arch: "x64", backend: "cpu", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-ubuntu-x64.tar.gz`, size: 22886629, sha256: "9f10432ca3f66ef003a7a540aaffb9da0acadaefd05404521b9ab7a2436af304" },
  ] },
  { id: "linux-vulkan-arm64", os: "linux", arch: "arm64", backend: "vulkan", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-ubuntu-vulkan-arm64.tar.gz`, size: 29008240, sha256: "cd5dd8071fa7998b6fa7c3b05d8cfd3c5fe9ca293c987845dc63c558a3972fb6" },
  ] },
  { id: "linux-cpu-arm64", os: "linux", arch: "arm64", backend: "cpu", assets: [
    { file: `llama-${RUNTIME_TAG}-bin-ubuntu-arm64.tar.gz`, size: 18593046, sha256: "4246edb69267ac637899594dd158878b7db8b8ff7961203fc2e18ebee27b9f94" },
  ] },
];

export type Gpu = { name: string; vendor: "nvidia" | "amd" | "intel" | "apple" | "other"; vramBytes: number | null };
export type Hardware = { os: "windows" | "macos" | "linux"; arch: "x64" | "arm64"; ramBytes: number; gpus: Gpu[] };

/** the build to install on this machine (the app lets the person override it) */
export function pickRuntime(hw: Hardware): RuntimeBuild {
  const options = RUNTIMES.filter((r) => r.os === hw.os && r.arch === hw.arch);
  const want: RuntimeBuild["backend"][] =
    hw.os === "macos" ? ["metal", "cpu"]
    : hw.gpus.some((g) => g.vendor === "nvidia") && hw.os === "windows" ? ["cuda", "vulkan", "cpu"]
    : hw.gpus.some((g) => g.vendor !== "other" || (g.vramBytes ?? 0) > 0) ? ["vulkan", "cpu"]
    : ["cpu"];
  for (const b of want) {
    const r = options.find((o) => o.backend === b);
    if (r) return r;
  }
  return options[0] ?? RUNTIMES.find((r) => r.id === "linux-cpu-x64")!;
}

export type ModelEntry = {
  id: string;
  name: string;
  /** billions of parameters (total; for mixture-of-experts this is all experts) */
  paramsB: number;
  /** active parameters per token, for MoE models (drives speed and rewards); equals paramsB for dense models */
  activeB: number;
  file: string;
  url: string;
  size: number;
  sha256: string;
  license: string;
  /** can call tools (agents need this); chat-only models are offered for chat jobs only */
  tools: boolean;
  /** conservative estimate of KV cache + compute buffers at MIN_CONTEXT, bytes */
  overheadBytes: number;
  source: "huggingface" | "registry";
  note?: string;
};

const hf = (repo: string, rev: string, file: string) => `https://huggingface.co/${repo}/resolve/${rev}/${file}`;

/** Qwen3.5 (Apache-2.0, tool calling). Q4_K_M quantization: the usual quality/size balance. */
export const MODELS: ModelEntry[] = [
  {
    id: "qwen3.5-2b-q4km", name: "Qwen3.5 2B", paramsB: 2, activeB: 2, tools: true, license: "apache-2.0", source: "huggingface",
    file: "Qwen3.5-2B-Q4_K_M.gguf", size: 1280835840, sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
    url: hf("unsloth/Qwen3.5-2B-GGUF", "f6d5376be1edb4d416d56da11e5397a961aca8ae", "Qwen3.5-2B-Q4_K_M.gguf"),
    overheadBytes: 1.25 * GiB, note: "Fast on almost anything. Simple chats and quick tool calls.",
  },
  {
    id: "qwen3.5-4b-q4km", name: "Qwen3.5 4B", paramsB: 4, activeB: 4, tools: true, license: "apache-2.0", source: "huggingface",
    file: "Qwen3.5-4B-Q4_K_M.gguf", size: 2740937888, sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
    url: hf("unsloth/Qwen3.5-4B-GGUF", "e87f176479d0855a907a41277aca2f8ee7a09523", "Qwen3.5-4B-Q4_K_M.gguf"),
    overheadBytes: 1.5 * GiB, note: "Good everyday model for 8 GB machines.",
  },
  {
    id: "qwen3.5-9b-q4km", name: "Qwen3.5 9B", paramsB: 9, activeB: 9, tools: true, license: "apache-2.0", source: "huggingface",
    file: "Qwen3.5-9B-Q4_K_M.gguf", size: 5680522464, sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
    url: hf("unsloth/Qwen3.5-9B-GGUF", "3885219b6810b007914f3a7950a8d1b469d598a5", "Qwen3.5-9B-Q4_K_M.gguf"),
    overheadBytes: 2 * GiB, note: "The sweet spot for 8–16 GB GPUs and Macs.",
  },
  {
    id: "qwen3.5-27b-q4km", name: "Qwen3.5 27B", paramsB: 27, activeB: 27, tools: true, license: "apache-2.0", source: "huggingface",
    file: "Qwen3.5-27B-Q4_K_M.gguf", size: 16740812704, sha256: "84b5f7f112156d63836a01a69dc3f11a6ba63b10a23b8ca7a7efaf52d5a2d806",
    url: hf("unsloth/Qwen3.5-27B-GGUF", "3221f178a6b842d04f1fb42f1c413534adcc0a6a", "Qwen3.5-27B-Q4_K_M.gguf"),
    overheadBytes: 4 * GiB, note: "High quality. Wants a 24 GB GPU or a 32 GB+ Mac.",
  },
  {
    id: "qwen3.5-35b-a3b-q4km", name: "Qwen3.5 35B-A3B", paramsB: 35, activeB: 3, tools: true, license: "apache-2.0", source: "huggingface",
    file: "Qwen3.5-35B-A3B-Q4_K_M.gguf", size: 22016023168, sha256: "3b46d1066bc91cc2d613e3bc22ce691dd77e6f0d33c9060690d24ce6de494375",
    url: hf("unsloth/Qwen3.5-35B-A3B-GGUF", "bc014a17be43adabd7066b7a86075ff935c6a4e2", "Qwen3.5-35B-A3B-Q4_K_M.gguf"),
    overheadBytes: 3 * GiB, note: "Mixture of experts: big-model quality, runs fast even partly in system RAM.",
  },
];

/** A ModelRegistry entry (on chain) whose weights are a GGUF file becomes servable: its sha256 is already on chain. */
export type RegistryModel = { id: number; name: string; version: number; weightsHash: string; weightsURI: string; approved: boolean };

export function registryEntries(models: RegistryModel[], sizes: Record<string, number> = {}): ModelEntry[] {
  return models
    .filter((m) => m.approved && /\.gguf$/i.test(m.weightsURI) && /^(ar:\/\/|https:\/\/)/.test(m.weightsURI))
    .map((m) => {
      const sha = m.weightsHash.replace(/^0x/, "").toLowerCase();
      return {
        id: `delphi-${m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-v${m.version}`.slice(0, 64),
        name: `${m.name} v${m.version} (Delphi)`, paramsB: 0, activeB: 0, tools: false, license: "delphi", source: "registry" as const,
        file: `${m.name}-v${m.version}.gguf`.replace(/[^A-Za-z0-9._-]/g, "_"),
        url: m.weightsURI.startsWith("ar://") ? `https://arweave.net/${m.weightsURI.slice(5)}` : m.weightsURI,
        size: sizes[sha] ?? 0, sha256: sha, overheadBytes: 2 * GiB,
        note: "Trained with the Delphi training fund; weights hash from the on-chain registry.",
      };
    });
}

export type Fit = "green" | "amber" | "red";
export const FIT_LABEL: Record<Fit, string> = { green: "Fits your GPU", amber: "Uses system RAM (slower)", red: "Too big for this machine" };

/**
 * Hermes-style fit check. green: model + 64K context fit in GPU memory. amber: it spills into system RAM (works,
 * slower). red: it won't fit. llama.cpp then places layers itself (-ngl auto); this is for choosing, not tuning.
 */
export function fitOf(m: Pick<ModelEntry, "size" | "overheadBytes">, hw: Hardware): Fit {
  const need = m.size + m.overheadBytes;
  const ram = hw.ramBytes;
  if (hw.os === "macos" && hw.arch === "arm64") {
    // unified memory: Metal may use roughly 2/3 to 3/4 of it by default
    if (need <= ram * 0.66) return "green";
    if (need <= ram * 0.8) return "amber";
    return "red";
  }
  const vram = Math.max(0, ...hw.gpus.map((g) => g.vramBytes ?? 0));
  if (vram > 0 && need <= vram * 0.92) return "green";
  if (need <= vram * 0.92 + ram * 0.6) return "amber";
  return "red";
}

export function formatBytes(n: number): string {
  if (!n) return "–";
  return n >= GiB ? `${(n / GiB).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}
