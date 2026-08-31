import { readFile } from "node:fs/promises";

/** 加载完整判据包（含检查协议，供批评者逐句执行） */
export async function loadCriteria(path = "experiments/criteria.md"): Promise<string> {
  return readFile(path, "utf-8");
}

/** 加载精简判据（写手自检版，避免把批评者的执行协议塞给写手造成负担） */
export async function loadWriterCriteria(path = "experiments/criteria-writer.md"): Promise<string> {
  return readFile(path, "utf-8");
}
