import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set(["node_modules", ".p0", ".local-validation", ".git"]);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
  if (item.isDirectory() && excluded.has(item.name)) return [];
  const full = path.join(dir, item.name);
  return item.isDirectory() ? walk(full) : [full];
});
const files = walk(root);
const markdown = files.filter((file) => file.endsWith(".md"));
const errors = [];
let links = 0;
let fragmentLinks = 0;
let jsonExamples = 0;
let diagrams = 0;
const hashes = {};
const documents = new Map();
const headingSlug = (heading) => heading
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
  .replace(/<[^>]*>/g, "")
  .trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "")
  .replace(/\s/g, "-");
for (const file of markdown) {
  const text = fs.readFileSync(file, "utf8");
  hashes[path.relative(root, file).replaceAll("\\", "/")] = crypto.createHash("sha256").update(text).digest("hex");
  const lines = text.split(/\r?\n/);
  const prose = lines.map(() => "");
  let fence = null;
  let language = null;
  let block = [];
  let openingLine = 0;
  lines.forEach((line, index) => {
    if (fence !== null) {
      if (new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \t]*$`).test(line)) {
        if (language === "json") {
          try { JSON.parse(block.join("\n")); jsonExamples++; }
          catch (error) { errors.push(`${file}:${openingLine}: ${error.message}`); }
        }
        if (language === "mermaid") {
          diagrams++;
          if (!block[0]?.startsWith("flowchart ")) errors.push(`${file}:${openingLine}: unsupported diagram header`);
        }
        language = null;
        fence = null;
      } else block.push(line);
      return;
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (opening) {
      fence = { marker: opening[1][0], length: opening[1].length };
      language = opening[2].trim().split(/\s+/)[0];
      openingLine = index + 1;
      block = [];
      if (!language) errors.push(`${file}:${index + 1}: missing fence language`);
    } else {
      prose[index] = line;
      if (/^#{1,6} /.test(line) && index + 1 < lines.length && lines[index + 1] !== "") errors.push(`${file}:${index + 1}: heading needs blank line`);
      if (/^(?:- |[0-9]+\. )/.test(line) && index > 0 && lines[index - 1] !== "" && !/^(?:- |[0-9]+\. )/.test(lines[index - 1])) errors.push(`${file}:${index + 1}: list needs blank line`);
    }
  });
  if (fence !== null) errors.push(`${file}:${openingLine}: unclosed fence`);
  const anchors = new Set();
  for (const [index, line] of prose.entries()) {
    const heading = line.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/)?.[1]
      ?? (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && index > 0 ? prose[index - 1].trim() : null);
    if (heading) {
      const base = headingSlug(heading);
      let anchor = base;
      let suffix = 0;
      while (anchors.has(anchor)) anchor = `${base}-${++suffix}`;
      anchors.add(anchor);
    }
  }
  const content = prose.join("\n").replace(/(`+)([\s\S]*?)\1(?!`)/g, "");
  for (const match of content.matchAll(/<[a-z][^>]*\s(?:id|name)=["']([^"']+)["'][^>]*>/gi)) anchors.add(match[1]);
  documents.set(file, { content, anchors });
}
for (const [file, { content }] of documents) {
  const targets = [
    ...[...content.matchAll(/\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))(?:\s+["'][^)\n]*["'])?\s*\)/g)].map(match => match[1] ?? match[2]),
    ...[...content.matchAll(/^ {0,3}\[(?!\^)[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)].map(match => match[1] ?? match[2]),
  ];
  for (const target of targets) {
    if ((!path.isAbsolute(target) && /^[a-z][a-z0-9+.-]*:/i.test(target)) || target.startsWith("//")) continue;
    const hashIndex = target.indexOf("#");
    let pathname = hashIndex < 0 ? target : target.slice(0, hashIndex);
    let fragment = hashIndex < 0 ? "" : target.slice(hashIndex + 1);
    try { pathname = decodeURIComponent(pathname); fragment = decodeURIComponent(fragment); }
    catch { errors.push(`${file}: invalid URL encoding ${target}`); continue; }
    pathname = pathname.replace(/:[0-9]+$/, "");
    const resolved = pathname ? path.resolve(path.dirname(file), pathname) : file;
    links++;
    if (!fs.existsSync(resolved)) { errors.push(`${file}: broken local link ${target}`); continue; }
    if (fragment && documents.has(resolved)) {
      fragmentLinks++;
      if (!documents.get(resolved).anchors.has(fragment)) errors.push(`${file}: missing Markdown anchor ${target}`);
    }
  }
}
for (const file of files.filter((file) => file.endsWith(".json"))) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
    for (const excerpt of data.excerpts ?? []) {
      if (!Number.isInteger(excerpt.start) || !Number.isInteger(excerpt.end) || excerpt.end < excerpt.start) errors.push(`${file}: invalid source line range`);
      else if (excerpt.text.split(/\r?\n/).length !== excerpt.end - excerpt.start + 1) errors.push(`${file}: source excerpt line count mismatch`);
    }
  } catch (error) { errors.push(`${file}: ${error.message}`); }
}
const report = {
  checkedAt: new Date().toISOString(),
  command: "node scripts/validate-docs.mjs",
  markdownFiles: markdown.length,
  localLinks: links,
  markdownFragmentLinks: fragmentLinks,
  jsonExamples,
  mermaidSyntaxShapeChecks: diagrams,
  errors,
  hashes,
  limitations: "Checks document structure, local links, Markdown heading/HTML anchors, JSON and excerpt ranges. This is not a full Markdown renderer; remote links and non-Markdown fragments are not checked. Mermaid was not rendered. Runtime and model tests have separate reports."
};
const output = path.join(root, ".local-validation/results/document-validation.json");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, hashes: undefined, output }, null, 2));
process.exitCode = errors.length ? 1 : 0;
