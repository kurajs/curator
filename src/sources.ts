// Step 1 (vendor-neutral): map changed files → candidate doc pages via each page's `sources:`
// frontmatter. Only pages whose sources globs intersect the diff are candidates — targeted,
// cheap, explainable. (Mirrors @kurajs/docs's sources contract; kept here so the Action has no
// runtime dependency on the framework's internals.)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function parseSources(md: string): string[] {
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1].split("\n").find((l) => l.trim().startsWith("sources:"));
  if (!line) return [];
  return line.replace(/.*sources:/, "").trim().replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function matchGlob(glob: string, file: string): boolean {
  if (glob.endsWith("/**")) return file === glob.slice(0, -3) || file.startsWith(glob.slice(0, -2));
  if (glob.includes("*")) {
    const re = new RegExp("^" + glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*\\\*/g, ".*").replace(/\\\*/g, "[^/]*") + "$");
    return re.test(file);
  }
  return glob === file;
}

/** Doc pages (relative to docsDir) whose `sources:` intersect the changed files. */
export function candidatesFor(docsDir: string, changed: string[]): string[] {
  let files: string[] = [];
  try {
    files = readdirSync(docsDir, { recursive: true } as any).filter((f) => String(f).endsWith(".md")) as string[];
  } catch {
    return [];
  }
  return files.filter((f) => parseSources(readFileSync(join(docsDir, f), "utf8")).some((s) => changed.some((c) => matchGlob(s, c))));
}
