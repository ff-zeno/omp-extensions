#!/usr/bin/env node
/**
 * Report UI drift on added lines.
 * Zero dependencies. Node >= 18 or Bun.
 * Run with the project as the working directory.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const SOURCE_EXT = new Set([".tsx", ".jsx", ".vue", ".svelte", ".css", ".scss"]);
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo",
  "storybook-static", "out", "vendor", ".cache", ".vercel",
]);
const PALETTES = [
  "slate", "gray", "zinc", "neutral", "stone", "red", "orange", "amber", "yellow",
  "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet",
  "purple", "fuchsia", "pink", "rose", "mauve", "olive", "mist", "taupe",
];
const GRAYS = new Set(["slate", "gray", "zinc", "neutral", "stone", "mauve", "olive", "mist", "taupe"]);
const PALETTE_INTENT = {
  red: "destructive", rose: "destructive", pink: "destructive",
  green: "success", emerald: "success", lime: "success",
  amber: "warning", yellow: "warning", orange: "warning",
  blue: "primary", sky: "info", cyan: "info", indigo: "primary",
  violet: "accent", purple: "accent", fuchsia: "accent",
};
const SEMANTIC_STEMS = [
  "background", "foreground", "primary", "secondary", "muted", "accent",
  "destructive", "success", "warning", "info", "card", "popover", "border", "ring", "input",
];
const SPACING_UTILS = new Set([
  "p", "px", "py", "pt", "pr", "pb", "pl", "ps", "pe",
  "m", "mx", "my", "mt", "mr", "mb", "ml", "ms", "me",
  "gap", "gap-x", "gap-y", "space-x", "space-y",
]);
const COLOR_UTILS = /^(?:bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|fill|stroke|outline|decoration|from|to|via|caret|accent|divide|placeholder|shadow|inset-shadow)$/;
const TEXT_SIZES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const FONT_WEIGHTS = new Set(["thin", "extralight", "light", "normal", "medium", "semibold", "bold", "extrabold", "black"]);
const SHADOW_STEPS = new Set(["shadow-2xs", "shadow-xs", "shadow-sm", "shadow", "shadow-md", "shadow-lg", "shadow-xl", "shadow-2xl"]);
const RUNTIME_PREFIXES = [
  "--radix-", "--tw-", "--vaul-", "--sonner-", "--base-ui-", "--recharts-",
  "--input-otp-", "--cmdk-", "--kb-", "--melt-", "--headlessui-", "--nextui-",
  "--chakra-", "--ark-", "--floating-",
];
const RUNTIME_EXACT = new Set([
  "--removed-body-scroll-bar-size",
  "--scrollbar-width",
  "--visual-viewport-height",
]);
const TAILWIND_EXACT = new Set([
  "--spacing",
  "--default-transition-duration",
  "--default-transition-timing-function",
  "--default-font-family",
  "--default-font-feature-settings",
  "--default-font-variation-settings",
  "--default-mono-font-family",
  "--default-mono-font-feature-settings",
  "--default-mono-font-variation-settings",
]);
const TAILWIND_PREFIXES = [
  "--color-", "--text-", "--font-", "--radius-", "--shadow-",
  "--inset-shadow-", "--drop-shadow-", "--ease-", "--animate-",
  "--breakpoint-", "--container-", "--tracking-", "--leading-",
  "--blur-", "--perspective-", "--aspect-",
];
const KIT_FALLBACKS = [
  "src/components/ui",
  "components/ui",
  "app/components/ui",
  "packages/ui/src",
  "packages/ui",
];
const COLOR_CHANNEL_TOLERANCE = 6;
const LENGTH_TOLERANCE_PX = 0.5;
const MAX_FILE_BYTES = 700_000;

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.error) {
    fail(args.error);
    return;
  }

  const cwd = process.cwd();
  const kit = resolveKit(cwd, args.kit);
  const index = buildIndex(cwd, kit);

  let files;
  if (args.all) {
    files = scanAll(cwd, args.paths);
  } else {
    const diff = loadDiff(cwd, args);
    if (diff.error) {
      fail(diff.error);
      return;
    }
    files = diff.files;
  }

  const findings = [];
  const scanned = [];
  for (const file of files) {
    if (!shouldScan(file.path, index)) continue;
    const abs = path.resolve(cwd, file.path);
    let disk = "";
    if (fs.existsSync(abs)) {
      try {
        disk = fs.readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      if (isGenerated(disk)) continue;
    }
    const lines = args.all ? visibleLines(disk) : commentFree(file.lines);
    scanned.push({ path: file.path, lines });
    checkFile(file.path, lines, index, findings);
  }
  checkOneOffs(cwd, index, scanned, findings);

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));
  const unique = dedupe(findings);
  if (args.json) {
    process.stdout.write(JSON.stringify(unique, null, 2) + "\n");
  } else if (unique.length) {
    process.stdout.write(unique.map(formatFinding).join("\n") + "\n");
  }
  if (unique.length && process.exitCode !== 2) process.exitCode = 1;
}

function parseArgs(argv) {
  const out = { paths: [], all: false, staged: false, json: false, help: false, base: null, kit: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") out.help = true;
    else if (arg === "--all") out.all = true;
    else if (arg === "--staged") out.staged = true;
    else if (arg === "--json") out.json = true;
    else if (arg === "--base") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return { error: "--base needs a ref" };
      out.base = value;
    } else if (arg === "--kit") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) return { error: "--kit needs a directory" };
      out.kit = value;
    } else if (arg.startsWith("--")) {
      return { error: `unknown flag ${arg}` };
    } else {
      out.paths.push(arg);
    }
  }
  if (out.staged && out.all) return { error: "--staged and --all cannot be combined" };
  if (out.staged && out.base) return { error: "--staged and --base cannot be combined" };
  return out;
}

function fail(message) {
  process.stderr.write(`check-drift: ${message}\n`);
  process.exitCode = 2;
}

function git(args, cwd) {
  const res = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) return { ok: false, stdout: "", stderr: res.error.message };
  if (res.status !== 0) return { ok: false, stdout: res.stdout || "", stderr: (res.stderr || "").trim() };
  return { ok: true, stdout: res.stdout || "", stderr: "" };
}

function gitOut(args, cwd) {
  const res = git(args, cwd);
  return res.ok ? res.stdout : null;
}

function loadDiff(cwd, args) {
  if (!gitOut(["rev-parse", "--is-inside-work-tree"], cwd)) {
    return { error: "not a git repository. Pass --all to scan files without git." };
  }
  const diffArgs = [
    "-c", "core.quotePath=false",
    "diff", "-U0", "--no-color", "--no-ext-diff",
    "--src-prefix=a/", "--dst-prefix=b/",
  ];
  if (args.staged) {
    diffArgs.push("--cached");
  } else if (args.base) {
    diffArgs.push(args.base);
  } else {
    const base = defaultBase(cwd);
    if (!base) return { error: "could not find a default branch. Pass --base <ref> or --all." };
    diffArgs.push(base);
  }
  if (args.paths.length) diffArgs.push("--", ...args.paths);
  const res = git(diffArgs, cwd);
  if (!res.ok) {
    const detail = res.stderr.split("\n").find(Boolean) || "";
    return { error: detail ? `git diff failed: ${detail}` : "git diff failed" };
  }
  const files = parseDiff(res.stdout);
  if (!args.staged) appendUntracked(cwd, args.paths, files);
  return { files };
}

function defaultBase(cwd) {
  const origin = gitOut(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  const candidates = [];
  if (origin) candidates.push(origin.trim());
  const init = gitOut(["config", "--get", "init.defaultBranch"], cwd);
  if (init && init.trim()) candidates.push(init.trim());
  candidates.push("main", "master", "trunk", "origin/main", "origin/master");
  for (const name of candidates) {
    if (!gitOut(["rev-parse", "--verify", "--quiet", name], cwd)) continue;
    const base = gitOut(["merge-base", "HEAD", name], cwd);
    if (base && base.trim()) return base.trim();
  }
  if (gitOut(["rev-parse", "--verify", "--quiet", "HEAD"], cwd)) return "HEAD";
  return null;
}

function parseDiff(text) {
  const files = [];
  let current = null;
  let newLine = 0;
  for (const raw of text.split("\n")) {
    if (raw.startsWith("+++ ")) {
      let spec = raw.slice(4).trim();
      if (spec.startsWith('"') && spec.endsWith('"')) spec = spec.slice(1, -1);
      if (spec === "/dev/null") {
        current = null;
        continue;
      }
      const rel = spec.replace(/^(?:[ab]\/)/, "");
      current = { path: rel, lines: [] };
      files.push(current);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+")) {
      current.lines.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    } else if (raw.startsWith("\\")) {
      continue;
    } else if (!raw.startsWith("-")) {
      newLine++;
    }
  }
  return files;
}

const fileListCache = new Map();

function listProjectFiles(cwd) {
  if (fileListCache.has(cwd)) return fileListCache.get(cwd);
  if (!gitOut(["rev-parse", "--is-inside-work-tree"], cwd)) {
    fileListCache.set(cwd, null);
    return null;
  }
  const res = git(["-c", "core.quotePath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  const listed = res.ok ? res.stdout.split("\0").filter(Boolean) : [];
  fileListCache.set(cwd, listed);
  return listed;
}

function untrackedRels(cwd) {
  const res = git(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard"], cwd);
  if (!res.ok) return [];
  return res.stdout.split("\0").filter(Boolean);
}

function pathSelected(rel, paths) {
  if (!paths.length) return true;
  const norm = rel.split(path.sep).join("/");
  return paths.some((raw) => {
    const want = raw.split(path.sep).join("/").replace(/^\.\//, "").replace(/\/$/, "");
    return norm === want || norm.startsWith(want + "/");
  });
}

function appendUntracked(cwd, paths, files) {
  const seen = new Set(files.map((file) => file.path));
  for (const rel of untrackedRels(cwd)) {
    const norm = rel.split(path.sep).join("/");
    if (seen.has(norm) || !pathSelected(norm, paths)) continue;
    if (!SOURCE_EXT.has(path.extname(norm))) continue;
    const whole = readWhole(cwd, path.resolve(cwd, norm));
    if (!whole) continue;
    files.push({ path: whole.path, lines: whole.lines });
    seen.add(whole.path);
  }
}

function eachProjectFile(cwd, onFile) {
  const listed = listProjectFiles(cwd);
  if (!listed) {
    walkFiles(cwd, onFile);
    return;
  }
  for (const rel of listed) onFile(path.resolve(cwd, rel));
}


function scanAll(cwd, paths) {
  const listed = listProjectFiles(cwd);
  const targets = paths.length ? paths.map((p) => path.resolve(cwd, p)) : [cwd];
  const files = [];
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      fail(`no such path ${path.relative(cwd, target) || target}`);
      continue;
    }
    const stat = fs.statSync(target);
    if (stat.isFile()) {
      const whole = readWhole(cwd, target);
      if (whole) files.push(whole);
      continue;
    }
    if (listed) {
      const prefix = path.relative(cwd, target).split(path.sep).join("/");
      const root = prefix && prefix !== "." ? prefix + "/" : "";
      for (const rel of listed) {
        if (root && rel !== prefix && !rel.startsWith(root)) continue;
        if (!SOURCE_EXT.has(path.extname(rel))) continue;
        const whole = readWhole(cwd, path.resolve(cwd, rel));
        if (whole) files.push(whole);
      }
    } else {
      walkFiles(target, (abs) => {
        if (SOURCE_EXT.has(path.extname(abs))) {
          const whole = readWhole(cwd, abs);
          if (whole) files.push(whole);
        }
      });
    }
  }
  return files;
}

function readWhole(cwd, abs) {
  let text = "";
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) return null;
    text = fs.readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  return { path: path.relative(cwd, abs).split(path.sep).join("/"), lines: visibleLines(text), text };
}

function walkFiles(dir, onFile) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(abs, onFile);
    else if (entry.isFile()) onFile(abs);
  }
}

function shouldScan(rel, index) {
  const norm = rel.split(path.sep).join("/");
  if (!SOURCE_EXT.has(path.extname(norm))) return false;
  if (norm.split("/").some((part) => SKIP_DIRS.has(part))) return false;
  if (/\.(test|spec|stories|story)\.[a-z]+$/i.test(norm)) return false;
  if (/\.(gen|generated)\.[a-z]+$/i.test(norm)) return false;
  if (norm.includes("/__tests__/") || norm.includes("/__snapshots__/") || norm.includes("/generated/")) return false;
  if (index.tokenFiles.has(norm)) return false;
  return true;
}

function isGenerated(text) {
  const head = text.slice(0, 600).toLowerCase();
  return head.includes("@generated") || head.includes("auto-generated") || head.includes("autogenerated") || head.includes("do not edit");
}

function visibleLines(text) {
  const out = [];
  let block = false;
  let jsx = false;
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (block) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      block = false;
    }
    if (jsx) {
      const end = line.indexOf("*/}");
      if (end === -1) continue;
      line = line.slice(end + 3);
      jsx = false;
    }
    line = stripLineComment(line);
    const blockAt = line.indexOf("/*");
    if (blockAt !== -1) {
      const end = line.indexOf("*/", blockAt + 2);
      if (end === -1) {
        block = true;
        line = line.slice(0, blockAt);
      } else {
        line = line.slice(0, blockAt) + line.slice(end + 2);
      }
    }
    const jsxAt = line.indexOf("{/*");
    if (jsxAt !== -1) {
      const end = line.indexOf("*/}", jsxAt + 3);
      if (end === -1) {
        jsx = true;
        line = line.slice(0, jsxAt);
      } else {
        line = line.slice(0, jsxAt) + line.slice(end + 3);
      }
    }
    out.push({ line: i + 1, text: line });
  }
  return out;
}

function commentFree(lines) {
  return lines.filter((row) => {
    const trimmed = row.text.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*") || trimmed.startsWith("<!--")) return false;
    if (trimmed.startsWith("{/*")) return false;
    return true;
  });
}

function stripLineComment(line) {
  let quote = null;
  for (let i = 0; i < line.length - 1; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") return line.slice(0, i);
  }
  return line;
}

function resolveKit(cwd, override) {
  if (override) {
    const abs = path.resolve(cwd, override);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
      fail(`kit directory not found: ${override}`);
      return { rel: null, abs: null, exports: new Map(), wrapped: new Map() };
    }
    return describeKit(cwd, abs);
  }
  const config = findComponentsJson(cwd);
  if (config) {
    const alias = config.json?.aliases?.ui;
    if (alias) {
      const resolved = resolveAlias(alias, config.dir, config.tsconfig);
      if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        return describeKit(cwd, resolved, config);
      }
    }
  }
  for (const rel of KIT_FALLBACKS) {
    const abs = path.join(cwd, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) return describeKit(cwd, abs, config);
  }
  return { rel: null, abs: null, exports: new Map(), wrapped: new Map(), config };
}

function findComponentsJson(cwd) {
  const found = [];
  eachProjectFile(cwd, (abs) => {
    if (path.basename(abs) === "components.json") found.push(abs);
  });
  found.sort((a, b) => a.split(path.sep).length - b.split(path.sep).length);
  for (const abs of found) {
    try {
      const json = parseJsonc(fs.readFileSync(abs, "utf8"));
      const dir = path.dirname(abs);
      return { abs, dir, json, tsconfig: readTsconfig(dir) };
    } catch {
      continue;
    }
  }
  return null;
}

function readTsconfig(dir) {
  for (const name of ["tsconfig.json", "tsconfig.app.json"]) {
    const abs = path.join(dir, name);
    if (!fs.existsSync(abs)) continue;
    try {
      return parseJsonc(fs.readFileSync(abs, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

function parseJsonc(text) {
  let out = "";
  let quote = null;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      out += ch;
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += ch;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

function resolveAlias(alias, dir, tsconfig) {
  const baseUrl = tsconfig?.compilerOptions?.baseUrl || ".";
  const paths = tsconfig?.compilerOptions?.paths || {};
  for (const [key, targets] of Object.entries(paths)) {
    if (!Array.isArray(targets) || !targets.length) continue;
    const star = key.indexOf("*");
    const prefix = star === -1 ? key : key.slice(0, star);
    if (!alias.startsWith(prefix)) continue;
    const rest = alias.slice(prefix.length);
    const target = String(targets[0]).replace("*", rest);
    const abs = path.resolve(dir, baseUrl, target);
    if (fs.existsSync(abs)) return abs;
    const alt = path.resolve(dir, target);
    if (fs.existsSync(alt)) return alt;
  }
  if (alias.startsWith("@/")) {
    const rest = alias.slice(2);
    for (const root of ["src", "."]) {
      const abs = path.resolve(dir, root, rest);
      if (fs.existsSync(abs)) return abs;
    }
  }
  const direct = path.resolve(dir, alias);
  return fs.existsSync(direct) ? direct : null;
}

function describeKit(cwd, abs, config) {
  const rel = path.relative(cwd, abs).split(path.sep).join("/");
  const exports = new Map();
  const wrapped = new Map();
  let entries = [];
  try {
    entries = fs.readdirSync(abs);
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const stem = name.replace(/\.[a-z]+$/, "");
    if (!stem || stem.startsWith(".")) continue;
    exports.set(stem, pascal(stem));
  }
  walkFiles(abs, (file) => {
    if (!SOURCE_EXT.has(path.extname(file)) && !file.endsWith(".ts")) return;
    let text = "";
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return;
    }
    for (const spec of importSpecs(text)) {
      const pkg = packageName(spec);
      if (!pkg) continue;
      if (!wrapped.has(pkg)) wrapped.set(pkg, path.relative(cwd, file).split(path.sep).join("/"));
    }
  });
  return { rel, abs, exports, wrapped, config };
}

function pascal(stem) {
  return stem.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function importSpecs(text) {
  const specs = [];
  const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  let match;
  while ((match = re.exec(text))) specs.push(match[1]);
  return specs;
}

function packageName(spec) {
  if (spec.startsWith("@radix-ui/")) {
    const parts = spec.split("/");
    return parts.slice(0, 2).join("/");
  }
  if (spec === "@base-ui/react" || spec.startsWith("@base-ui/react/")) return "@base-ui/react";
  return null;
}

function buildIndex(cwd, kit) {
  const defined = new Map();
  const tokenFiles = new Set();
  const colorTokens = [];
  const radiusTokens = [];
  const shadowTokens = [];
  const fontSizeTokens = [];
  const spacingTokens = [];
  let spacingBasePx = null;
  let tailwind = false;

  const config = kit.config || findComponentsJson(cwd);
  if (config?.json?.tailwind?.css) {
    const css = path.resolve(config.dir, config.json.tailwind.css);
    if (fs.existsSync(css)) tokenFiles.add(path.relative(cwd, css).split(path.sep).join("/"));
  }
  eachProjectFile(cwd, (abs) => {
    const rel = path.relative(cwd, abs).split(path.sep).join("/");
    const base = path.basename(abs);
    if (/^(tokens|design-tokens)\.(json|css|scss)$/i.test(base)) tokenFiles.add(rel);
    if (/^tailwind\.config\.[cm]?[jt]s$/.test(base)) tokenFiles.add(rel);
  });

  const cssFiles = [];
  eachProjectFile(cwd, (abs) => {
    const ext = path.extname(abs);
    if (ext === ".css" || ext === ".scss") cssFiles.push(abs);
  });
  const imported = new Set();
  let tailwindUnresolved = false;
  for (const abs of cssFiles) {
    absorbCss(abs, cwd, defined, imported, 0);
    const text = safeRead(abs);
    if (text.includes("@import \"tailwindcss\"") || text.includes("@import 'tailwindcss'") || text.includes("@theme")) {
      tailwind = true;
    }
    if (unresolvedTailwindImport(text, abs, cwd)) tailwindUnresolved = true;
  }
  absorbSourceDefinitions(cwd, defined);
  absorbTokenJson(cwd, defined);
  absorbTailwindConfig(cwd, defined);

  for (const [name, values] of defined) {
    for (const raw of values) {
      const resolved = resolveValue(raw, defined, 0);
      if (!resolved) continue;
      if (name === "--spacing") {
        const px = toPx(resolved.trim());
        if (px) spacingBasePx = px;
      }
      const color = parseColor(resolved);
      if (color && (name.startsWith("--color-") || isSemanticName(name) || color)) {
        if (name.startsWith("--color-") || isSemanticName(name) || looksLikeColorName(name)) {
          colorTokens.push({ name, color });
        }
      }
      if (/radius/.test(name) && !String(raw).trim().startsWith("var(")) {
        const px = toPx(resolved.trim());
        if (px != null) radiusTokens.push({ name, px });
      }
      if (/shadow/.test(name) && !resolved.includes("var(")) shadowTokens.push({ name, value: normalizeShadow(resolved) });
      if (name.startsWith("--text-") || name.startsWith("--font-size-")) {
        const px = toPx(firstLength(resolved));
        if (px != null) fontSizeTokens.push({ name, px });
      }
      if ((name.startsWith("--space-") || name.startsWith("--spacing-")) && name !== "--spacing") {
        const px = toPx(resolved.trim());
        if (px != null) spacingTokens.push({ name, px });
      }
    }
  }
  if (spacingBasePx == null && tailwind) spacingBasePx = 4;

  return {
    defined,
    tokenFiles,
    colorTokens,
    radiusTokens,
    shadowTokens,
    fontSizeTokens,
    spacingTokens,
    spacingBasePx,
    tailwind,
    tailwindUnresolved,
    semantic: hasSemantic(defined),
    kit,
  };
}

function isSemanticName(name) {
  const stem = name.replace(/^--color-/, "").replace(/^--/, "");
  return SEMANTIC_STEMS.some((item) => stem === item || stem.startsWith(item + "-"));
}

function looksLikeColorName(name) {
  return /^--(?:color-)?(?:background|foreground|primary|secondary|muted|accent|destructive|success|warning|info|card|popover|border|ring|input|chart)/.test(name);
}

function hasSemantic(defined) {
  let count = 0;
  for (const stem of SEMANTIC_STEMS) {
    if (defined.has(`--${stem}`) || defined.has(`--color-${stem}`)) count++;
  }
  return count >= 3;
}

function safeRead(abs) {
  try {
    const stat = fs.statSync(abs);
    if (stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(abs, "utf8");
  } catch {
    return "";
  }
}

function absorbCss(abs, cwd, defined, imported, depth) {
  if (depth > 2 || imported.has(abs)) return;
  imported.add(abs);
  const text = stripCssComments(safeRead(abs));
  if (!text) return;
  collectDeclarations(text, defined);
  const property = /@property\s+(--[A-Za-z0-9-]+)/g;
  let match;
  while ((match = property.exec(text))) addDef(defined, match[1], "initial");
  if (depth === 0 || abs.includes("node_modules")) {
    const imp = /@import\s+(?:"([^"]+)"|'([^']+)')/g;
    while ((match = imp.exec(text))) {
      const spec = match[1] || match[2];
      const resolved = resolveCssImport(spec, abs, cwd);
      if (resolved) absorbCss(resolved, cwd, defined, imported, depth + 1);
    }
  }
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function collectDeclarations(text, defined) {
  const re = /(?:^|[^-\w(])(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+)/g;
  let match;
  while ((match = re.exec(text))) {
    const name = match[1];
    if (name.includes("*")) continue;
    addDef(defined, name, match[2].trim());
  }
}

function addDef(defined, name, value) {
  if (!defined.has(name)) defined.set(name, []);
  const list = defined.get(name);
  if (!list.includes(value)) list.push(value);
}

function resolveCssImport(spec, fromFile, cwd) {
  if (spec.startsWith(".")) {
    const abs = path.resolve(path.dirname(fromFile), spec);
    return fs.existsSync(abs) ? abs : null;
  }
  const starts = [path.dirname(fromFile), cwd];
  const seen = new Set();
  for (const start of starts) {
    let dir = start;
    while (dir && !seen.has(dir)) {
      seen.add(dir);
      const hit = resolvePackageStyle(path.join(dir, "node_modules", spec));
      if (hit) return hit;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

function resolvePackageStyle(target) {
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  const pkgJson = path.join(target, "package.json");
  if (!fs.existsSync(pkgJson)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8"));
    const style = pkg.style || pkg.sass || null;
    if (!style) return null;
    const abs = path.resolve(path.dirname(pkgJson), style);
    return fs.existsSync(abs) ? abs : null;
  } catch {
    return null;
  }
}

function unresolvedTailwindImport(text, fromFile, cwd) {
  const re = /@import\s+(?:"([^"]+)"|'([^']+)')/g;
  let match;
  let missing = false;
  while ((match = re.exec(text))) {
    const spec = match[1] || match[2];
    if (spec !== "tailwindcss" && !spec.startsWith("tailwindcss/")) continue;
    if (!resolveCssImport(spec, fromFile, cwd)) missing = true;
  }
  return missing;
}

function isTailwindDefault(name) {
  if (TAILWIND_EXACT.has(name)) return true;
  return TAILWIND_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function absorbSourceDefinitions(cwd, defined) {
  eachProjectFile(cwd, (abs) => {
    const ext = path.extname(abs);
    if (![".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte"].includes(ext)) return;
    const text = safeRead(abs);
    if (!text || text.length > MAX_FILE_BYTES) return;
    const variable = /variable\s*:\s*["'](--[A-Za-z0-9-]+)["']/g;
    let match;
    while ((match = variable.exec(text))) addDef(defined, match[1], "runtime");
    const setProp = /setProperty\(\s*["'](--[A-Za-z0-9-]+)/g;
    while ((match = setProp.exec(text))) addDef(defined, match[1], "runtime");
    const styleDef = /["'](--[A-Za-z0-9-]+)["']\s*:/g;
    while ((match = styleDef.exec(text))) addDef(defined, match[1], "runtime");
    if (ext === ".vue" || ext === ".svelte") {
      const blocks = text.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi);
      for (const block of blocks) collectDeclarations(block[1], defined);
    }
    if (ext === ".ts" || ext === ".js") {
      if (/theme/i.test(path.basename(abs))) collectDeclarations(text, defined);
    }
  });
}

function absorbTokenJson(cwd, defined) {
  eachProjectFile(cwd, (abs) => {
    if (!/tokens.*\.json$/i.test(path.basename(abs))) return;
    try {
      const json = JSON.parse(fs.readFileSync(abs, "utf8"));
      walkTokenTree(json, [], defined);
    } catch {
      return;
    }
  });
}

function walkTokenTree(node, parts, defined) {
  if (!node || typeof node !== "object") return;
  const value = node.$value ?? node.value;
  if (typeof value === "string" && parts.length) {
    addDef(defined, "--" + parts.join("-"), value);
    return;
  }
  for (const [key, child] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    walkTokenTree(child, parts.concat(key.replace(/\s+/g, "-")), defined);
  }
}

function absorbTailwindConfig(cwd, defined) {
  eachProjectFile(cwd, (abs) => {
    if (!/^tailwind\.config\.[cm]?[jt]s$/.test(path.basename(abs))) return;
    const text = safeRead(abs);
    const re = /(?:colors|borderRadius|fontSize|boxShadow|spacing)\s*:\s*\{([\s\S]*?)\n\s*\}/g;
    let block;
    while ((block = re.exec(text))) {
      const kind = block[0].slice(0, block[0].indexOf(":"));
      const pair = /([A-Za-z0-9-]+)\s*:\s*["'`]([^"'`]+)["'`]/g;
      let match;
      while ((match = pair.exec(block[1]))) {
        const prefix = kind.includes("color") ? "--color-"
          : kind.includes("borderRadius") ? "--radius-"
            : kind.includes("fontSize") ? "--text-"
              : kind.includes("boxShadow") ? "--shadow-"
                : "--spacing-";
        addDef(defined, prefix + match[1], match[2]);
      }
    }
  });
}

function resolveValue(raw, defined, depth) {
  if (!raw || depth > 5) return raw;
  const match = String(raw).match(/^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,|\))/);
  if (!match) return raw;
  const next = defined.get(match[1]);
  if (!next || !next.length) return raw;
  const concrete = next.find((item) => item !== "runtime" && !item.startsWith("var(")) || next[0];
  if (concrete === "runtime") return raw;
  return resolveValue(concrete, defined, depth + 1);
}

function checkFile(rel, lines, index, findings) {
  const inKit = isInKit(rel, index.kit);
  const joined = lines.map((row) => row.text).join("\n");
  for (const row of lines) {
    if (row.text.length > 2000) continue;
    if (!inKit) {
      checkArbitrary(rel, row, index, findings);
      checkRawPalette(rel, row, index, findings);
      checkRawElement(rel, row, index, findings);
      checkPrimitiveImport(rel, row, index, findings);
    } else {
      checkRawPalette(rel, row, index, findings);
    }
    checkLiteral(rel, row, index, findings);
    checkInvented(rel, row, index, findings);
  }
  if (!inKit && /<input\b/.test(joined)) {
    checkSplitInput(rel, lines, index, findings);
  }
}

function isInKit(rel, kit) {
  if (!kit?.rel) return false;
  const norm = rel.split(path.sep).join("/");
  return norm === kit.rel || norm.startsWith(kit.rel + "/");
}

function checkArbitrary(rel, row, index, findings) {
  for (const classes of classStrings(row.text, true)) {
    for (const token of classes.split(/\s+/).filter(Boolean)) {
      if (!token.includes("[")) continue;
      const parts = splitVariants(token);
      const utility = parts[parts.length - 1].replace(/^!/, "").replace(/!$/, "");
      if (!utility.includes("[")) continue;
      const content = bracketContent(utility);
      if (content == null) continue;
      if (/var\s*\(|theme\s*\(/i.test(content)) continue;
      if (isLayoutValue(content)) continue;
      const base = utilityBase(utility);
      const color = isColorValue(content);
      const length = toPx(content);
      if (color && (COLOR_UTILS.test(base) || base === "text" || base === "font")) {
        add(findings, rel, row.line, "ugly", "arbitrary-value", `${token} sets a color outside the token set`, "use a semantic color token; derive a missing shade in the token file, after the user agrees");
        continue;
      }
      if (length != null && length <= 1 && (base === "border" || base.startsWith("border-"))) continue;
      if (length != null && isDesignUtility(base)) {
        const suggestion = spacingSuggestion(base, length, index) || designSuggestion(base, length, index) || "use the project's scale";
        add(findings, rel, row.line, "ugly", "arbitrary-value", `${token} is off the project's scale`, suggestion);
        continue;
      }
      if (base.startsWith("[") && /^(?:color|background|font-size|border-radius|box-shadow|padding|margin|gap|font-family)\s*:/i.test(content)) {
        if (/var\s*\(|theme\s*\(/i.test(content)) continue;
        add(findings, rel, row.line, "ugly", "arbitrary-value", `${token} sets a design property inline`, "use a token");
      }
    }
  }
}

function isDesignUtility(base) {
  if (SPACING_UTILS.has(base)) return true;
  if (base === "text" || base === "leading" || base === "tracking" || base === "font" || base === "size") return true;
  if (base === "rounded" || base.startsWith("rounded-")) return true;
  if (base === "shadow" || base.startsWith("shadow-") || base === "drop-shadow") return true;
  if (base === "border" || base.startsWith("border-")) return true;
  return false;
}

function isLayoutValue(content) {
  if (/^(?:auto|none|inherit|initial|unset|fit-content|min-content|max-content|stretch)$/i.test(content)) return true;
  if (/^-?[\d.]+(?:vh|vw|dvh|svh|lvh|dvw|svw|lvw|vmin|vmax|%)$/.test(content)) return true;
  if (/^-?[\d.]+(?:lh|cap|ch|ex|ic|em)$/.test(content)) return true;
  if (/^\d+\s*\/\s*\d+$/.test(content)) return true;
  if (/\bfr\b|minmax\(|repeat\(/.test(content)) return true;
  return false;
}

function spacingSuggestion(base, px, index) {
  if (!SPACING_UTILS.has(base) || !index.spacingBasePx) return null;
  const step = px / index.spacingBasePx;
  const nearest = Math.round(step);
  if (nearest < 0 || nearest > 96) return null;
  if (Math.abs(step - nearest) < 0.05) return `${base}-${nearest}`;
  const low = Math.floor(step);
  const high = Math.ceil(step);
  return `${base}-${low} (${low * index.spacingBasePx}px) or ${base}-${high} (${high * index.spacingBasePx}px)`;
}

function designSuggestion(base, px, index) {
  if (base === "rounded" || base.startsWith("rounded-")) {
    const hit = nearestLength(index.radiusTokens, px);
    if (hit) return `var(${hit.name})`;
    if (px >= 999) return "rounded-full";
  }
  if (base === "text" || base === "font") {
    const hit = nearestLength(index.fontSizeTokens, px);
    if (hit) return `var(${hit.name})`;
  }
  return null;
}

function nearestLength(tokens, px) {
  let best = null;
  for (const token of tokens) {
    const delta = Math.abs(token.px - px);
    if (delta <= LENGTH_TOLERANCE_PX && (!best || delta < best.delta)) best = { ...token, delta };
  }
  return best;
}

function checkRawPalette(rel, row, index, findings) {
  if (!index.semantic) return;
  if (/chart/i.test(rel)) return;
  for (const classes of classStrings(row.text)) {
    for (const token of classes.split(/\s+/).filter(Boolean)) {
      const parts = splitVariants(token);
      const utility = parts[parts.length - 1].replace(/^!/, "").replace(/!$/, "");
      const match = utility.match(new RegExp(`^(bg|text|border(?:-[trblxyse])?|ring|fill|stroke|outline|from|to|via|divide|placeholder)-(${PALETTES.join("|")})-(\\d{2,3})(?:/\\d{1,3})?$`));
      if (!match) continue;
      add(findings, rel, row.line, "ugly", "raw-palette", `${utility} is a raw palette step`, paletteSuggestion(match[1], match[2], index));
    }
  }
}

function paletteSuggestion(util, family, index) {
  let stem = PALETTE_INTENT[family];
  if (GRAYS.has(family)) {
    if (util === "text" || util === "fill" || util === "stroke" || util === "placeholder") stem = "muted-foreground";
    else if (util === "bg") stem = "muted";
    else if (util.startsWith("border") || util === "divide" || util === "outline") stem = "border";
    else if (util === "ring") stem = "ring";
    else stem = "muted";
  }
  if (stem && (index.defined.has(`--${stem}`) || index.defined.has(`--color-${stem}`))) return `${util}-${stem}`;
  return "a semantic color token";
}

function checkRawElement(rel, row, index, findings) {
  const kit = index.kit;
  if (!kit?.exports?.size) return;
  const text = row.text;
  if (hasTag(text, "button") && kit.exports.has("button")) {
    add(findings, rel, row.line, "ugly", "raw-element", "native <button> outside the kit", kit.exports.get("button"));
  }
  if (hasTag(text, "select") && (kit.exports.has("select") || kit.exports.has("native-select"))) {
    add(findings, rel, row.line, "ugly", "raw-element", "native <select> outside the kit", kit.exports.get("select") || kit.exports.get("native-select"));
  }
  if (hasTag(text, "textarea") && kit.exports.has("textarea")) {
    add(findings, rel, row.line, "ugly", "raw-element", "native <textarea> outside the kit", kit.exports.get("textarea"));
  }
  if (hasTag(text, "dialog") && kit.exports.has("dialog")) {
    add(findings, rel, row.line, "ugly", "raw-element", "native <dialog> outside the kit", kit.exports.get("dialog"));
  }
  if (hasTag(text, "input")) {
    const type = inputType(text);
    if (type === "hidden" || type === "file") return;
    if (type === "checkbox" && kit.exports.has("checkbox")) {
      add(findings, rel, row.line, "ugly", "raw-element", "native checkbox outside the kit", kit.exports.get("checkbox"));
      return;
    }
    if (type === "radio" && (kit.exports.has("radio-group") || kit.exports.has("radio"))) {
      add(findings, rel, row.line, "ugly", "raw-element", "native radio outside the kit", kit.exports.get("radio-group") || kit.exports.get("radio"));
      return;
    }
    if (type && type !== "checkbox" && type !== "radio" && kit.exports.has("input")) {
      add(findings, rel, row.line, "ugly", "raw-element", "native <input> outside the kit", kit.exports.get("input"));
    }
  }
  if (hasTag(text, "a") && kit.exports.has("button") && /\brole\s*=\s*["']button["']/.test(text)) {
    add(findings, rel, row.line, "ugly", "raw-element", "<a role=\"button\"> outside the kit", kit.exports.get("button"));
  }
}

function checkSplitInput(rel, lines, index, findings) {
  if (!index.kit?.exports?.has("input") && !index.kit?.exports?.has("checkbox")) return;
  for (let i = 0; i < lines.length; i++) {
    if (!hasTag(lines[i].text, "input")) continue;
    if (inputType(lines[i].text)) continue;
    const window = lines.slice(i, i + 4).map((row) => row.text).join(" ");
    const type = inputType(window);
    if (type === "hidden" || type === "file" || type == null) continue;
    if (type === "checkbox" || type === "radio") continue;
    add(findings, rel, lines[i].line, "ugly", "raw-element", "native <input> outside the kit", index.kit.exports.get("input"));
  }
}

function hasTag(text, tag) {
  return new RegExp(`(?:^|[\\s{(=])<${tag}\\b`).test(text);
}

function inputType(text) {
  const match = text.match(/\btype\s*=\s*["']([^"']+)["']/);
  return match ? match[1] : null;
}

function checkPrimitiveImport(rel, row, index, findings) {
  if (!index.kit?.wrapped?.size) return;
  for (const spec of importSpecs(row.text)) {
    const pkg = packageName(spec);
    if (!pkg || !index.kit.wrapped.has(pkg)) continue;
    add(findings, rel, row.line, "ugly", "primitive-import", `${pkg} is wrapped by the kit`, index.kit.wrapped.get(pkg));
  }
}

function checkLiteral(rel, row, index, findings) {
  const text = row.text;
  if (/\.[a-z]+$/.test(rel) && (rel.endsWith(".css") || rel.endsWith(".scss"))) {
    const decl = /(?:^|[;{])\s*([a-zA-Z-]+)\s*:\s*([^;{}]+)/g;
    let match;
    while ((match = decl.exec(text))) {
      judgeDeclaration(rel, row.line, match[1], match[2], index, findings);
    }
    return;
  }
  const style = text.match(/style=\{\{([\s\S]*)$/);
  if (!style) return;
  const pair = /([A-Za-z]+)\s*:\s*("[^"]*"|'[^']*'|-?[\d.]+)/g;
  let match;
  while ((match = pair.exec(style[1]))) {
    const prop = cssProp(match[1]);
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1);
    else if (/^(?:borderRadius|fontSize|padding|margin|gap|paddingTop|paddingRight|paddingBottom|paddingLeft)$/.test(match[1])) value = `${value}px`;
    else continue;
    judgeDeclaration(rel, row.line, prop, value, index, findings);
  }
}

function cssProp(name) {
  return name.replace(/[A-Z]/g, (ch) => "-" + ch.toLowerCase());
}

function judgeDeclaration(rel, line, prop, rawValue, index, findings) {
  if (prop.startsWith("--")) return;
  const value = rawValue.trim();
  if (!value || /var\s*\(|theme\s*\(/i.test(value)) return;
  if (/^(?:inherit|initial|unset|revert|none|auto|currentcolor|transparent)$/i.test(value)) return;
  if (isColorProp(prop)) {
    for (const chunk of colorChunks(value)) {
      if (isScrim(chunk)) continue;
      const parsed = parseColor(chunk);
      if (!parsed) continue;
      const hit = nearestColor(index.colorTokens, parsed);
      if (hit) {
        add(findings, rel, line, "ugly", "literal-value", `${prop}: ${chunk} matches ${hit.name}`, `var(${hit.name})`);
      } else if (index.colorTokens.length) {
        add(findings, rel, line, "fragile", "literal-value", `${prop}: ${chunk} is not in the token set`, "derive it with color-mix() from a base token, or ask before adding one");
      }
    }
    return;
  }
  if (/radius/.test(prop) && index.radiusTokens.length) {
    for (const length of lengthsIn(value)) {
      if (length.px === 0 || length.px >= 999 || length.raw === "50%") continue;
      const hit = nearestLength(index.radiusTokens, length.px);
      if (hit) add(findings, rel, line, "ugly", "literal-value", `${prop}: ${length.raw} matches ${hit.name}`, `var(${hit.name})`);
      else add(findings, rel, line, "fragile", "literal-value", `${prop}: ${length.raw} is not a radius token`, "use a radius token");
    }
    return;
  }
  if (prop === "font-size" && index.fontSizeTokens.length) {
    const length = toPx(value);
    if (length == null) return;
    const hit = nearestLength(index.fontSizeTokens, length);
    if (hit) add(findings, rel, line, "ugly", "literal-value", `font-size: ${value} matches ${hit.name}`, `var(${hit.name})`);
    return;
  }
  if (/^(?:padding|margin|gap|row-gap|column-gap|padding-(?:top|right|bottom|left|inline|block)|margin-(?:top|right|bottom|left|inline|block))$/.test(prop) && index.spacingTokens.length) {
    for (const length of lengthsIn(value)) {
      if (length.px <= 1) continue;
      const hit = nearestLength(index.spacingTokens, length.px);
      if (hit) add(findings, rel, line, "ugly", "literal-value", `${prop}: ${length.raw} matches ${hit.name}`, `var(${hit.name})`);
    }
    return;
  }
  if ((prop === "box-shadow" || prop === "text-shadow") && index.shadowTokens.length) {
    const norm = normalizeShadow(value);
    const hit = index.shadowTokens.find((token) => token.value === norm);
    if (hit) add(findings, rel, line, "ugly", "literal-value", `${prop} matches ${hit.name}`, `var(${hit.name})`);
  }
}

function isColorProp(prop) {
  return /^(?:color|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color|border-top-color|border-right-color|border-bottom-color|border-left-color)$/.test(prop)
    || prop === "background" || prop === "border";
}

function colorChunks(value) {
  const out = [];
  const re = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]+\)|hsla?\([^)]+\)|oklch\([^)]+\)|oklab\([^)]+\)|hwb\([^)]+\)/g;
  let match;
  while ((match = re.exec(value))) out.push(match[0]);
  return out;
}

function isScrim(chunk) {
  const parsed = parseColor(chunk);
  if (!parsed) return false;
  const [r, g, b, a] = parsed;
  if (a < 1 && r <= 8 && g <= 8 && b <= 8) return true;
  if (a < 1 && r >= 247 && g >= 247 && b >= 247) return true;
  return false;
}

function lengthsIn(value) {
  const out = [];
  const re = /-?[\d.]+(?:px|rem|em)/g;
  let match;
  while ((match = re.exec(value))) {
    const px = toPx(match[0]);
    if (px != null) out.push({ raw: match[0], px });
  }
  return out;
}

function firstLength(value) {
  const match = String(value).match(/-?[\d.]+(?:px|rem|em)/);
  return match ? match[0] : "";
}

function checkInvented(rel, row, index, findings) {
  const re = /var\(\s*(--[A-Za-z0-9-]+)\s*(,([^)]*))?\)/g;
  let match;
  while ((match = re.exec(row.text))) {
    const name = match[1];
    if (index.defined.has(name)) continue;
    if (index.tailwindUnresolved && isTailwindDefault(name)) continue;
    if (RUNTIME_EXACT.has(name) || RUNTIME_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    const fallback = match[2] != null;
    add(
      findings,
      rel,
      row.line,
      fallback ? "fragile" : "broken",
      "invented-token",
      `${name} is not defined`,
      fallback ? "use a defined token; a fallback hides a missing one" : "use a defined token",
    );
  }
}

function checkOneOffs(cwd, index, files, findings) {
  const counts = histogram(cwd, index);
  const rare = new Map();
  for (const [family, map] of counts) {
    let total = 0;
    let topName = "";
    let top = 0;
    for (const [name, count] of map) {
      total += count;
      if (count > top) {
        top = count;
        topName = name;
      }
    }
    if (total < 8 || top / total < 0.85) continue;
    for (const [name, count] of map) {
      if (count > 2 || name === topName) continue;
      if (name.includes("[")) continue;
      if (name === "rounded-full" || name === "rounded-none" || name === "shadow-none") continue;
      rare.set(`${family}:${name}`, { family, name, count, topName, top });
    }
  }
  if (!rare.size) return;
  for (const file of files) {
    if (!shouldScan(file.path, index) || isInKit(file.path, index.kit)) continue;
    for (const row of file.lines) {
      for (const classes of classStrings(row.text)) {
        for (const token of classes.split(/\s+/).filter(Boolean)) {
          const utility = (splitVariants(token).pop() || "").replace(/^!/, "").replace(/!$/, "");
          const hit = classifyScale(utility);
          if (!hit) continue;
          const key = `${hit.family}:${hit.name}`;
          const info = rare.get(key);
          if (!info) continue;
          add(
            findings,
            file.path,
            row.line,
            "fragile",
            "one-off",
            `${info.name} is used ${info.count} time${info.count === 1 ? "" : "s"}; ${info.topName} is used ${info.top}`,
            info.topName,
          );
        }
      }
    }
  }
}

function histogram(cwd, index) {
  const counts = new Map();
  eachProjectFile(cwd, (abs) => {
    const rel = path.relative(cwd, abs).split(path.sep).join("/");
    if (!shouldScan(rel, index) || isInKit(rel, index.kit)) return;
    if (![".tsx", ".jsx", ".vue", ".svelte", ".css"].includes(path.extname(rel))) return;
    const text = safeRead(abs);
    if (!text || isGenerated(text)) return;
    for (const row of visibleLines(text)) {
      for (const classes of classStrings(row.text)) {
        for (const token of classes.split(/\s+/).filter(Boolean)) {
          const utility = (splitVariants(token).pop() || "").replace(/^!/, "").replace(/!$/, "");
          const hit = classifyScale(utility);
          if (!hit || hit.name.includes("[")) continue;
          if (!counts.has(hit.family)) counts.set(hit.family, new Map());
          const map = counts.get(hit.family);
          map.set(hit.name, (map.get(hit.name) || 0) + 1);
        }
      }
    }
  });
  return counts;
}

function classifyScale(utility) {
  const opacity = utility.replace(/\/\d{1,3}$/, "");
  const rounded = opacity.match(/^rounded(?:-(?:tl|tr|bl|br|ss|se|ee|es|t|r|b|l|s|e))?-(.+)$/);
  if (rounded) return { family: "rounded", name: `rounded-${rounded[1]}` };
  if (opacity === "rounded") return { family: "rounded", name: "rounded" };
  const gap = opacity.match(/^gap(?:-[xy])?-(.+)$/);
  if (gap) return { family: "gap", name: `gap-${gap[1]}` };
  if (SHADOW_STEPS.has(opacity)) return { family: "shadow", name: opacity };
  const text = opacity.match(/^text-(.+)$/);
  if (text && TEXT_SIZES.has(text[1])) return { family: "text", name: opacity };
  const weight = opacity.match(/^font-(.+)$/);
  if (weight && FONT_WEIGHTS.has(weight[1])) return { family: "font", name: opacity };
  return null;
}

function classStrings(line, loose = false) {
  const out = [];
  const styling = /(?:className|class)\s*=|\bcn\s*\(|\bclsx\s*\(|\bcva\s*\(|\btwMerge\s*\(|\btwJoin\s*\(|@apply\b/.test(line);
  const apply = line.match(/@apply\s+([^;]+)/);
  if (apply) out.push(apply[1]);
  for (const value of extractStrings(line)) {
    const staticParts = value.split(/\$\{[^}]*\}/);
    for (const part of staticParts) {
      if (!looksLikeClasses(part)) continue;
      const count = part.trim().split(/\s+/).filter(Boolean).length;
      if (!styling && (!loose || count < 2)) continue;
      out.push(part);
    }
  }
  return out;
}

function extractStrings(line) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;
  let match;
  while ((match = re.exec(line))) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

function looksLikeClasses(value) {
  const text = value.trim();
  if (!text || text.length > 500) return false;
  if (text.includes("/") && !text.includes(" ") && !text.includes("[")) return false;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 80) return false;
  let ok = 0;
  for (const token of tokens) {
    if (token.length > 160) return false;
    if (/^[!a-zA-Z@[\]&:.\/0-9_-]+$/.test(token) && (token.includes("-") || token.includes("[") || token.includes(":") || /^(?:flex|grid|hidden|block|inline|relative|absolute|fixed|sticky|group|peer|container|contents|sr-only)$/.test(token))) {
      ok++;
    }
  }
  return ok > 0 && ok / tokens.length >= 0.5;
}

function splitVariants(token) {
  const parts = [];
  let current = "";
  let depth = 0;
  for (const ch of token) {
    if (ch === "[") depth++;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    if (ch === ":" && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (current) parts.push(current);
  if (!parts.length) return [token || ""];
  return parts;
}

function bracketContent(utility) {
  const match = utility.match(/\[([^\[\]]*)\]/);
  return match ? match[1] : null;
}

function utilityBase(utility) {
  const bare = utility.replace(/^-/, "");
  const bracket = bare.indexOf("[");
  const name = bracket === -1 ? bare : bare.slice(0, bracket);
  return name.replace(/-$/, "");
}

function isColorValue(value) {
  return /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)
    || /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|hwb)\(/i.test(value);
}

function toPx(raw) {
  const match = String(raw).trim().match(/^(-?[\d.]+)(px|rem|em)$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  if (match[2] === "px") return n;
  return n * 16;
}

function parseColor(raw) {
  const text = String(raw).trim();
  const hex = text.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hex) return hexToRgba(hex[1]);
  const rgb = text.match(/^rgba?\(\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (rgb) return [channel(rgb[1]), channel(rgb[2]), channel(rgb[3]), alpha(rgb[4])];
  const hsl = text.match(/^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+%?)\s*[, ]\s*([\d.]+%?)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i);
  if (hsl) {
    const [r, g, b] = hslToRgb(Number(hsl[1]), percent(hsl[2]), percent(hsl[3]));
    return [r, g, b, alpha(hsl[4])];
  }
  const oklch = text.match(/^oklch\(\s*([\d.]+%?)\s+([\d.]+%?)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/i);
  if (oklch) {
    let L = percentOrNumber(oklch[1]);
    if (L > 1) L = L / 100;
    let C = Number(oklch[2].replace("%", ""));
    if (oklch[2].endsWith("%")) C = C / 100;
    const [r, g, b] = oklchToRgb(L, C, Number(oklch[3]));
    return [r, g, b, alpha(oklch[4])];
  }
  return null;
}

function hexToRgba(hex) {
  const full = hex.length === 3 || hex.length === 4
    ? hex.split("").map((ch) => ch + ch).join("")
    : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  const a = full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

function channel(raw) {
  if (raw.endsWith("%")) return Math.round(percent(raw) * 255);
  return Math.round(Number(raw));
}

function percent(raw) {
  if (String(raw).endsWith("%")) return Number(String(raw).slice(0, -1)) / 100;
  return Number(raw);
}

function percentOrNumber(raw) {
  if (String(raw).endsWith("%")) return Number(String(raw).slice(0, -1)) / 100;
  return Number(raw);
}

function alpha(raw) {
  if (raw == null || raw === "") return 1;
  if (String(raw).endsWith("%")) return Number(String(raw).slice(0, -1)) / 100;
  return Number(raw);
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs(hp % 2 - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function oklchToRgb(L, C, H) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const b2 = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  const gamma = (x) => {
    const clamped = Math.min(1, Math.max(0, x));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  return [Math.round(gamma(r) * 255), Math.round(gamma(g) * 255), Math.round(gamma(b2) * 255)];
}

function nearestColor(tokens, rgba) {
  let best = null;
  for (const token of tokens) {
    if (Math.abs(token.color[3] - rgba[3]) > 0.04) continue;
    const delta = Math.max(
      Math.abs(token.color[0] - rgba[0]),
      Math.abs(token.color[1] - rgba[1]),
      Math.abs(token.color[2] - rgba[2]),
    );
    if (delta <= COLOR_CHANNEL_TOLERANCE && (!best || delta < best.delta)) best = { name: token.name, delta };
  }
  return best;
}

function normalizeShadow(value) {
  return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function add(findings, rel, line, tier, rule, message, suggestion) {
  findings.push({
    path: rel.split(path.sep).join("/"),
    line,
    tier,
    rule,
    message,
    suggestion,
  });
}

function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const finding of findings) {
    const key = `${finding.path}:${finding.line}:${finding.rule}:${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}

function formatFinding(finding) {
  return `${finding.path}:${finding.line}  ${finding.tier}  ${finding.rule}  ${finding.message}  -> ${finding.suggestion}`;
}

const HELP = `check-drift — report UI drift against the project's kit and tokens

Usage:
  check-drift.mjs [paths...] [flags]

Default: added lines versus the merge-base with the default branch,
including staged, unstaged, and untracked files. --staged is staged only.
Run in the project root.

Flags:
  --base <ref>   Diff against this ref instead of the merge-base
  --staged       Staged changes only
  --all          Scan whole files. Inside git, tracked and untracked source, gitignore respected.
  --json         JSON array on stdout
  --kit <dir>    Kit directory override
  --help         Show this help

Exit 0 when clean, 1 when any finding, 2 on usage error.
Findings: path:line  tier  rule  message  -> suggestion
Tiers: broken, ugly, fragile.
`;

main();
