import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ChangedFile, ReviewOptions } from "./types.js";

const STATUS_MAP: Record<string, ChangedFile["status"]> = {
  M: "modified",
  A: "added",
  R: "renamed",
  C: "copied",
  D: "deleted",
};

function detectLanguage(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "TypeScript",
    tsx: "TypeScript/React",
    js: "JavaScript",
    jsx: "JavaScript/React",
    py: "Python",
    go: "Go",
    rs: "Rust",
    java: "Java",
    kt: "Kotlin",
    php: "PHP",
    rb: "Ruby",
    swift: "Swift",
    cs: "C#",
    cpp: "C++",
    c: "C",
    h: "C/C++ Header",
    scala: "Scala",
    sql: "SQL",
    html: "HTML",
    css: "CSS",
    scss: "SCSS",
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    md: "Markdown",
    sh: "Shell",
    bash: "Shell",
    zsh: "Shell",
    dockerfile: "Dockerfile",
  };
  return map[ext ?? ""] ?? null;
}

function parseDiffOutput(stdout: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const statusCode = parts[0]?.[0];
    if (!statusCode) continue;
    const status = STATUS_MAP[statusCode];
    if (!status) continue;
    const path = parts[1];
    if (!path) continue;
    files.push({ path, status, language: detectLanguage(path) });
  }
  return files;
}

export async function getChangedFiles(
  pi: ExtensionAPI,
  cwd: string,
  options: ReviewOptions,
): Promise<ChangedFile[]> {
  if (options.files.length > 0) {
    return options.files.map((path) => ({
      path,
      status: "modified" as const,
      language: detectLanguage(path),
    }));
  }

  let diffCmd: string;
  let diffArgs: string[];

  if (options.staged) {
    diffCmd = "git";
    diffArgs = ["-C", cwd, "diff", "--cached", "--name-status"];
  } else if (options.ref !== "HEAD") {
    diffCmd = "git";
    diffArgs = ["-C", cwd, "diff", "--name-status", `${options.ref}...HEAD`];
  } else {
    diffCmd = "git";
    diffArgs = ["-C", cwd, "diff", "--name-status", "HEAD"];
  }

  const result = await pi.exec(diffCmd, diffArgs);
  return parseDiffOutput(result.stdout);
}

export async function getFileDiff(
  pi: ExtensionAPI,
  cwd: string,
  filePath: string,
  options: ReviewOptions,
): Promise<string> {
  let args: string[];
  if (options.staged) {
    args = ["-C", cwd, "diff", "--cached", "--", filePath];
  } else if (options.ref !== "HEAD") {
    args = ["-C", cwd, "diff", `${options.ref}...HEAD`, "--", filePath];
  } else {
    args = ["-C", cwd, "diff", "HEAD", "--", filePath];
  }

  const result = await pi.exec("git", args);
  return result.stdout;
}
