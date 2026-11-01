/** Typed calls into the Rust side (src-tauri/src/inference.rs). */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Hardware, ModelEntry, RuntimeBuild } from "@delphi/lib/inference/catalog";
import { runtimeUrl } from "@delphi/lib/inference/catalog";

export type Settings = { modelDir: string; defaultModelDir: string; runtimeId: string | null; apiKey: string; port: number };
export type FileStatus = { file: string; ready: boolean; partial: number };
export type Running = { port: number; model_file: string; started: number };
export type Status = { running: Running | null; exited: string | null; log: string[] };
export type Progress = { id: string; done: number; total: number; stage: "download" | "verified" | "extract" };

export const hardware = () => invoke<Hardware>("infer_hardware");
export const settings = () => invoke<Settings>("infer_settings");
export const setModelDir = (dir: string | null) => invoke<void>("infer_set_model_dir", { dir });
export const cancel = (id: string) => invoke<void>("infer_cancel", { id });
export const runtimePath = (id: string) => invoke<string | null>("infer_runtime_path", { id });
export const installRuntime = (r: RuntimeBuild) =>
  invoke<string>("infer_install_runtime", { id: r.id, assets: r.assets.map((a) => ({ url: runtimeUrl(a), file: a.file, size: a.size, sha256: a.sha256 })) });
export const modelsStatus = (models: ModelEntry[]) =>
  invoke<FileStatus[]>("infer_models_status", { files: models.map((m) => ({ file: m.file, size: m.size, sha256: m.sha256 })) });
export const downloadModel = (m: ModelEntry) =>
  invoke<void>("infer_download_model", { id: m.id, url: m.url, file: m.file, size: m.size, sha256: m.sha256 });
export const deleteModel = (m: ModelEntry) => invoke<void>("infer_delete_model", { file: m.file });
export const start = (runtimeId: string, m: ModelEntry, ctx: number) =>
  invoke<{ port: number; apiKey: string }>("infer_start", { runtimeId, file: m.file, sha256: m.sha256, ctx });
export const stop = () => invoke<void>("infer_stop");
export const status = () => invoke<Status>("infer_status");
export const nodeSecretHex = () => invoke<string>("infer_node_secret");
export const onProgress = (f: (p: Progress) => void): Promise<UnlistenFn> => listen<Progress>("infer-progress", (e) => f(e.payload));

export async function waitHealthy(port: number, apiKey: string, timeoutMs = 180_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: `Bearer ${apiKey}` } });
      if (r.ok) return true;
    } catch { /* still loading */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
