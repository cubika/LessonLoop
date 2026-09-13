import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excluded = new Set(["node_modules", ".p0", ".git"]);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
  if (item.isDirectory() && excluded.has(item.name)) return [];
  const full = path.join(dir, item.name);
  return item.isDirectory() ? walk(full) : [full];
});
const files = walk(root);
const markdown = files.filter((file) => file.endsWith(".md"));
const errors = [];
let links = 0;
let jsonExamples = 0;
let diagrams = 0;
const hashes = {};
for (const file of markdown) {
  const text = fs.readFileSync(file, "utf8");
  hashes[path.relative(root, file).replaceAll("\\", "/")] = crypto.createHash("sha256").update(text).digest("hex");
  const lines = text.split(/\r?\n/);
  let language = null;
  let block = [];
  let openingLine = 0;
  lines.forEach((line, index) => {
    if (line.startsWith("```")) {
      if (language === null) {
        language = line.slice(3).trim();
        openingLine = index + 1;
        block = [];
        if (!language) errors.push(`${file}:${index + 1}: missing fence language`);
      } else {
        if (language === "json") {
          try { JSON.parse(block.join("\n")); jsonExamples++; }
          catch (error) { errors.push(`${file}:${openingLine}: ${error.message}`); }
        }
        if (language === "mermaid") {
          diagrams++;
          if (!block[0]?.startsWith("flowchart ")) errors.push(`${file}:${openingLine}: unsupported diagram header`);
        }
        language = null;
      }
    } else if (language !== null) block.push(line);
    else {
      if (/^#{1,6} /.test(line) && index + 1 < lines.length && lines[index + 1] !== "") errors.push(`${file}:${index + 1}: heading needs blank line`);
      if (/^(?:- |[0-9]+\. )/.test(line) && index > 0 && lines[index - 1] !== "" && !/^(?:- |[0-9]+\. )/.test(lines[index - 1])) errors.push(`${file}:${index + 1}: list needs blank line`);
    }
  });
  if (language !== null) errors.push(`${file}:${openingLine}: unclosed fence`);
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].replace(/^<|>$/g, "");
    if (/^https?:/.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    target = target.replace(/:[0-9]+$/, "");
    const resolved = path.isAbsolute(target) ? target : path.resolve(path.dirname(file), target);
    links++;
    if (!fs.existsSync(resolved)) errors.push(`${file}: broken local link ${target}`);
  }
}
for (const file of files.filter((file) => file.endsWith(".json") && !file.endsWith("document-validation.json"))) {
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
  jsonExamples,
  mermaidSyntaxShapeChecks: diagrams,
  errors,
  hashes,
  limitations: "This command checks document structure, local links, JSON and excerpt ranges only. Mermaid was not rendered. Runtime and model tests, if any, have separate reports."
};
fs.writeFileSync(path.join(root, "docs/research/2026-09-12/document-validation.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ ...report, hashes: undefined }, null, 2));
process.exitCode = errors.length ? 1 : 0;
