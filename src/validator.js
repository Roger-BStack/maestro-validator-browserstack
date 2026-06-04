/**
 * BrowserStack Maestro Test Suite Validator — Core Engine
 *
 * Replicates the three phases of validation that BrowserStack's
 * Maestro runner pipeline performs:
 *
 *   Phase 1 — Upload validation (Uploader)
 *   Phase 2 — Build API validation (/build endpoint)
 *   Phase 3 — Pre-Execution Scan (Maestro Session Runner - Dry Run)
 */

const JSZip = require("jszip");
const yaml = require("js-yaml");
const path = require("path");
const fs = require("fs");

// ─── Constants ───────────────────────────────────────────────────────────────

const ALLOWED_EXTENSIONS = new Set([
  ".yaml", ".yml", ".js", ".png", ".jpeg", ".jpg", ".gif", ".mp4",
]);

const IGNORED_FILES = new Set([
  // macOS
  '.DS_Store',
  '._*',
  '.Trash',
  '__MACOSX',
  
  // Windows
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  '$RECYCLE.BIN',
  
  // Linux
  '.directory',
  '.Trash-*',
  '*~'
]);

const MAX_ZIP_SIZE_BYTES = 1 * 1024 * 1024 * 1024;        // 1 GB
const MAX_UNARCHIVED_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_FILENAME_LENGTH = 255;
const ALLOWED_FILENAME_CHARS = /^[a-zA-Z0-9._\-\s\[\]/,\{\}\(\)@]+$/;
const ALLOWED_EXECUTE_CHARS = /^[a-zA-Z0-9._\-\s\[\]/,\{\}\(\)@#]+$/;
const MAX_ENV_KEY_LENGTH = 30;
const MAX_ENV_VALUE_LENGTH = 100;
const DRY_RUN_TIMEOUT_MS = 120_000;

// ─── Result Accumulator ─────────────────────────────────────────────────────

class ValidationResult {
  constructor(phase) {
    this.phase = phase;
    this.errors = [];
    this.warnings = [];
  }

  addError(code, message, file = null) {
    this.errors.push({ code, message, ...(file && { file }) });
  }

  addWarning(code, message, file = null) {
    this.warnings.push({ code, message, ...(file && { file }) });
  }

  get isValid() {
    return this.errors.length === 0;
  }

  summary() {
    return {
      phase: this.phase,
      valid: this.isValid,
      errorCount: this.errors.length,
      warningCount: this.warnings.length,
      errors: this.errors,
      warnings: this.warnings,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Upload Validation
// ═══════════════════════════════════════════════════════════════════════════════

async function validateUpload(zipBuffer, zipFilename) {
  const result = new ValidationResult("upload");

  if (!zipFilename.toLowerCase().endsWith(".zip")) {
    result.addError(
      "BROWSERSTACK_INVALID_TESTSUITE",
      `File must be a .zip archive. Received: "${zipFilename}"`
    );
  }

  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    result.addError(
      "FILE_SIZE_EXCEEDED",
      `Zip exceeds 1 GB limit (${(zipBuffer.length / 1e9).toFixed(2)} GB)`
    );
  }

  const baseName = path.basename(zipFilename, ".zip");
  if (baseName.length > MAX_FILENAME_LENGTH) {
    result.addError(
      "INVALID_FILENAME",
      `Zip filename exceeds ${MAX_FILENAME_LENGTH} characters`
    );
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (e) {
    result.addError(
      "BROWSERSTACK_INVALID_TESTSUITE",
      `Cannot parse zip file: ${e.message}`
    );
    // Cannot continue without a parseable zip — return accumulated errors so far.
    return result;
  }

  let totalUncompressedSize = 0;
  const entries = Object.values(zip.files);

  for (const entry of entries) {
    const entryPath = entry.name;

    // Check every path segment for hidden directories/files (recursive — catches
    // hidden dirs at any nesting depth, including directory entries themselves).
    const segments = entryPath.split("/");
    for (const segment of segments) {
      if (segment && segment.startsWith(".")) {
        result.addError(
          "HIDDEN_DIRECTORY",
          "Invalid File Found: Hidden directory or file detected (name starts with '.')",
          entryPath
        );
        break;
      }
    }

    if (entry.dir) continue;

    if (entry.unixPermissions && (entry.unixPermissions & 0o120000) === 0o120000) {
      result.addError(
        "SYMBOLIC_LINK",
        "Invalid File Found: Symbolic link detected",
        entryPath
      );
    }

    if (entryPath.includes("../") || entryPath.includes("..\\")) {
      result.addError(
        "PATH_TRAVERSAL",
        "Invalid File Found: Path traversal detected",
        entryPath
      );
    }

    const fileSegments = entryPath.split("/");
    for (const segment of fileSegments) {
      if (segment && !ALLOWED_FILENAME_CHARS.test(segment)) {
        result.addError(
          "MALICIOUS_FILE",
          "Invalid Filename: Filename can contain only alpha numeric characters and spaces.",
          entryPath
        );
        break;
      }
    }

    const ext = path.extname(entryPath).toLowerCase();
    if (!ext === "" && !ALLOWED_EXTENSIONS.has(ext)) {
      result.addError(
        "INVALID_FILE_TYPE",
        `File type "${ext}" is not allowed. Permitted: ${[...ALLOWED_EXTENSIONS].join(", ")}`,
        entryPath
      );
    }

    if (entry._data && entry._data.uncompressedSize) {
      totalUncompressedSize += entry._data.uncompressedSize;
    }
  }

  if (totalUncompressedSize > MAX_UNARCHIVED_SIZE_BYTES) {
    result.addError(
      "UNARCHIVED_SIZE_EXCEEDED",
      `Unarchived size (${(totalUncompressedSize / 1e9).toFixed(2)} GB) exceeds limit`
    );
  }

  const yamlEntries = entries.filter(
    (e) => !e.dir && /\.(ya?ml)$/i.test(e.name)
  );
  for (const entry of yamlEntries) {
    try {
      const content = await entry.async("string");
      yaml.loadAll(content);
    } catch (e) {
      result.addError("YAML_SYNTAX", `INVALID YAML FILE: ${e.message}`, entry.name);
    }
  }

  const filesAtRoot = entries.filter((e) => !e.dir && !e.name.includes("/"));
  if (filesAtRoot.length > 0) {
    result.addWarning(
      "MISSING_ROOT_FOLDER",
      "Test suite files should be inside a root folder, not at the zip root. This may cause discovery issues."
    );
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 2 — Build API Validation
// ═══════════════════════════════════════════════════════════════════════════════

function validateBuildParams(buildParams = {}) {
  const result = new ValidationResult("build");
  const { execute, tags, config, shards, env } = buildParams;

  if (execute !== undefined) {
    const execArr = Array.isArray(execute) ? execute : [execute];

    if (execArr.length === 0) {
      result.addError(
        "test_param_format_invalid",
        "`execute` must be a non-empty array of strings"
      );
    }

    for (const item of execArr) {
      if (typeof item !== "string") {
        result.addError(
          "test_param_format_invalid",
          `\`execute\` items must be strings, got ${typeof item}`
        );
      } else if (!ALLOWED_EXECUTE_CHARS.test(item.replace(/\//g, ""))) {
        result.addError(
          "test_param_content_invalid",
          `\`execute\` value "${item}" contains invalid characters. Allowed: [a-z A-Z 0-9 . _ - #]`
        );
      }
    }
  }

  if (tags !== undefined) {
    if (typeof tags !== "object" || Array.isArray(tags)) {
      result.addError(
        "BROWSERSTACK_INVALID_TAGS_FORMAT",
        "`tags` must be a JSON object with `includeTags` and/or `excludeTags`"
      );
    } else {
      const { includeTags, excludeTags, ...rest } = tags;

      if (!includeTags && !excludeTags) {
        result.addError("BROWSERSTACK_EMPTY_TAGS", "`tags` cannot be empty");
      }
      if (includeTags && !Array.isArray(includeTags)) {
        result.addError(
          "BROWSERSTACK_INVALID_includeTags",
          "`includeTags` must be an array of strings"
        );
      }
      if (excludeTags && !Array.isArray(excludeTags)) {
        result.addError(
          "BROWSERSTACK_INVALID_excludeTags",
          "`excludeTags` must be an array of strings"
        );
      }
      if (Array.isArray(includeTags) && Array.isArray(excludeTags)) {
        const overlap = includeTags.filter((t) => excludeTags.includes(t));
        if (overlap.length > 0) {
          result.addError(
            "BROWSERSTACK_DUPLICATE_TAGS",
            `Tags appear in both includeTags and excludeTags: ${overlap.join(", ")}`
          );
        }
      }
      if (Object.keys(rest).length > 0) {
        result.addWarning(
          "UNKNOWN_TAGS_KEYS",
          `Unexpected keys in tags object: ${Object.keys(rest).join(", ")}`
        );
      }
    }
  }

  if (config !== undefined) {
    const configArr = Array.isArray(config) ? config : [config];
    for (const item of configArr) {
      if (typeof item !== "string") {
        result.addError(
          "test_param_format_invalid",
          `\`config\` items must be strings, got ${typeof item}`
        );
      }
    }
  }

  if (shards !== undefined && Array.isArray(shards)) {
    const VALID_SHARD_KEYS = new Set(["execute", "tags", "config"]);
    for (let i = 0; i < shards.length; i++) {
      const shard = shards[i];
      const values = shard.values || shard;
      if (typeof values !== "object") {
        result.addError(
          "BROWSERSTACK_INVALID_SHARD_VALUES",
          `Shard[${i}] values must be an object`
        );
        continue;
      }
      const keys = Object.keys(values);
      const hasValidKey = keys.some((k) => VALID_SHARD_KEYS.has(k));
      if (!hasValidKey) {
        result.addError(
          "BROWSERSTACK_INVALID_SHARD_VALUES",
          `Shard[${i}] must contain at least one of: execute, tags, config`
        );
      }
      for (const k of keys) {
        if (!VALID_SHARD_KEYS.has(k)) {
          result.addError(
            "BROWSERSTACK_INVALID_SHARD_VALUES_KEY",
            `Shard[${i}] contains unsupported key: "${k}"`
          );
        }
      }
    }
  }

  if (env !== undefined && typeof env === "object") {
    for (const [key, value] of Object.entries(env)) {
      if (key.length > MAX_ENV_KEY_LENGTH) {
        result.addError(
          "ENV_KEY_TOO_LONG",
          `Env key "${key}" exceeds ${MAX_ENV_KEY_LENGTH} chars`
        );
      }
      if (String(value).length > MAX_ENV_VALUE_LENGTH) {
        result.addError(
          "ENV_VALUE_TOO_LONG",
          `Env value for "${key}" exceeds ${MAX_ENV_VALUE_LENGTH} chars`
        );
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3 — Pre-Execution Simulation
// ═══════════════════════════════════════════════════════════════════════════════

async function simulateDryRun(zipBuffer, options = {}) {
  const result = new ValidationResult("dryRun");
  const startTime = Date.now();

  let zip;
  try {
    zip = await JSZip.loadAsync(zipBuffer);
  } catch (e) {
    result.addError("testsuite-parse-failed", `Cannot read zip: ${e.message}`);
    return result;
  }

  const entries = Object.values(zip.files).filter((e) => !e.dir);

  const topLevelDirs = [
    ...new Set(
      entries
        .map((e) => e.name.split("/")[0])
        .filter((seg) => entries.some((e) => e.name.startsWith(seg + "/")))
    ),
  ];

  const rootFolder = options.rootFolder || topLevelDirs[0];
  if (!rootFolder) {
    result.addError(
      "testsuite-parse-empty",
      "No root folder detected in zip — test suite structure is invalid"
    );
    return result;
  }

  const allYamlFiles = entries.filter(
    (e) => /\.(ya?ml)$/i.test(e.name) && e.name.startsWith(rootFolder + "/")
  );

  for (const entry of entries) {
    const segments = entry.name.split("/");

    const hasHidden = segments.some((s) => s.startsWith(".") && s.length > 1);
    if (hasHidden) {
      result.addWarning(
        "HIDDEN_FILE_DETECTED",
        "Hidden file/folder detected — will be excluded from discovery",
        entry.name
      );
    }
  }

  const flowFiles = [];
  const nonFlowYamls = [];

  for (const entry of allYamlFiles) {
    if (Date.now() - startTime > DRY_RUN_TIMEOUT_MS) {
      result.addError(
        "DRY_RUN_TIMEOUT",
        `Dry-run parsing exceeded ${DRY_RUN_TIMEOUT_MS / 1000}s timeout`
      );
      return result;
    }

    try {
      const content = await entry.async("string");
      const docs = yaml.loadAll(content).filter(Boolean);

      const isFlow = docs.some((doc) => {
        if (Array.isArray(doc)) return true;
        if (typeof doc === "object" && doc !== null) {
          const keys = Object.keys(doc);
          const maestroKeys = ["appId", "name", "tags", "env", "onFlowStart", "onFlowComplete"];
          return keys.some((k) => maestroKeys.includes(k)) || docs.length > 1;
        }
        return false;
      });

      if (isFlow) {
        flowFiles.push({ entry, docs });
      } else {
        nonFlowYamls.push(entry);
      }
    } catch (e) {
      result.addError(
        "testsuite-parse-failed",
        `YAML parse error: ${e.message}`,
        entry.name
      );
    }
  }

  for (const entry of nonFlowYamls) {
    result.addWarning(
      "NON_FLOW_FILE",
      "Non-flow YAML may cause parse failures on Android",
      entry.name
    );
  }

  if (flowFiles.length === 0 && result.errors.length === 0) {
    result.addError(
      "testsuite-parse-empty",
      "Dry run completed but discovered zero flow files"
    );
    return result;
  }

  if (options.execute && options.execute.length > 0) {
    const discoveredPaths = new Set(
      flowFiles.map((f) => {
        const rel = f.entry.name.startsWith(rootFolder + "/")
          ? f.entry.name.slice(rootFolder.length + 1)
          : f.entry.name;
        return rel;
      })
    );

    for (const execPath of options.execute) {
      if (!discoveredPaths.has(execPath)) {
        const withRoot = rootFolder + "/" + execPath;
        const doublePathed = flowFiles.some((f) => f.entry.name === withRoot);
        if (doublePathed) {
          result.addError(
            "testsuite-no-tests-found-flowfile",
            `Path "${execPath}" not found. The root folder is prepended automatically — do not include "${rootFolder}/" in execute paths.`,
            execPath
          );
        } else {
          result.addError(
            "testsuite-no-tests-found-flowfile",
            `Flow file "${execPath}" specified in \`execute\` was not found in the test suite`,
            execPath
          );
        }
      }
    }
  }

  const allFlowPaths = new Set(flowFiles.map((f) => f.entry.name));
  for (const { entry, docs } of flowFiles) {
    const refs = extractRunFlowRefs(docs);
    for (const ref of refs) {
      const dir = path.dirname(entry.name);
      const resolved = path.normalize(path.join(dir, ref));
      if (!allFlowPaths.has(resolved) && !allFlowPaths.has(ref)) {
        result.addError(
          "testsuite-parse-failed",
          `runFlow reference "${ref}" could not be resolved`,
          entry.name
        );
      }
    }
  }

  for (const { entry } of flowFiles) {
    const classname = extractClassname(entry.name);
    if (classname === null) {
      result.addError(
        "EXTRACT_CLASSNAME_NIL",
        "extract_classname returned nil — undefined method 'end_with?'",
        entry.name
      );
    }
  }

  return result;
}

// ─── Directory → Zip Buffer ──────────────────────────────────────────────────

/**
 * Recursively pack a directory into an in-memory zip buffer.
 * The directory name becomes the root folder inside the zip
 * (matching the structure BrowserStack expects).
 *
 * @param {string} dirPath  Absolute path to the directory
 * @returns {Promise<Buffer>}
 */
/**
 * If renameDotPrefixed is true, replace a single leading period in a file/folder
 * name segment with an underscore (e.g. ".hidden" → "_hidden").
 * A segment that is exactly "." or ".." is left unchanged.
 */
function applyDotRename(segment) {
  if (segment.startsWith(".") && segment !== "." && segment !== "..") {
    return "_" + segment.slice(1);
  }
  return segment;
}

/**
 * Rename all dot-prefixed path segments in a zip entry path.
 * e.g. ".hidden/foo/.bar.yaml" → "_hidden/foo/_bar.yaml"
 */
function renameDotPrefixedPath(entryPath) {
  return entryPath.split("/").map(applyDotRename).join("/");
}

/**
 * For every .js, .yml, and .yaml file in the zip, replace occurrences of
 * each renamed path (from → to) in the file's text content.
 * Only renames where from !== to are processed.
 *
 * In addition to full zip-path renames, this also substitutes individual
 * renamed path segments so that relative references (e.g. ".hidden/flow.yaml"
 * or just ".bar.yaml") inside file content are updated to use the new names.
 *
 * Returns a list of { file, from, to } objects for every substitution made.
 *
 * @param {JSZip} zip
 * @param {Array<{from: string, to: string}>} renames
 * @returns {Promise<Array<{file: string, from: string, to: string}>>}
 */
async function applyRenamesInTextFiles(zip, renames) {
  const TEXT_EXTENSIONS = /\.(js|ya?ml)$/i;
  const refUpdates = [];

  // Only process renames where the path actually changed.
  const effectiveRenames = renames.filter((r) => r.from !== r.to);
  if (effectiveRenames.length === 0) return refUpdates;

  // Expand renames to also include segment-level substitutions.
  // For a full-path rename like "root/.hidden/foo.yaml" → "root/_hidden/foo.yaml",
  // we also add the segment pair ".hidden" → "_hidden" so that relative references
  // inside file content (e.g. runFlow: .hidden/flow.yaml) are caught too.
  // Use a Map keyed on `from` to deduplicate.
  const allRenamesMap = new Map();
  for (const { from, to } of effectiveRenames) {
    allRenamesMap.set(from, to);
    // Derive segment-level pairs from each path component.
    const fromSegs = from.split("/");
    const toSegs = to.split("/");
    for (let i = 0; i < fromSegs.length; i++) {
      const segFrom = fromSegs[i];
      const segTo = toSegs[i] !== undefined ? toSegs[i] : segFrom;
      if (segFrom !== segTo && !allRenamesMap.has(segFrom)) {
        allRenamesMap.set(segFrom, segTo);
      }
    }
  }

  // Build a sorted list (longest `from` first) to avoid partial replacements.
  const sorted = [...allRenamesMap.entries()]
    .map(([from, to]) => ({ from, to }))
    .sort((a, b) => b.from.length - a.from.length);

  for (const [entryName, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (!TEXT_EXTENSIONS.test(entryName)) continue;

    let content = await entry.async("string");
    let changed = false;

    for (const { from, to } of sorted) {
      // Match the path as a substring (handles both full paths and relative refs).
      // Use a global replace so all occurrences in the file are updated.
      if (content.includes(from)) {
        content = content.split(from).join(to);
        refUpdates.push({ file: entryName, from, to });
        changed = true;
      }
    }

    if (changed) {
      zip.file(entryName, content);
    }
  }

  return refUpdates;
}

async function directoryToZipBuffer(dirPath, options = {}) {
  const { renameDotPrefixed = false } = options;
  const zip = new JSZip();
  const renames = []; // { from, to } pairs for reporting

  const origRootName = path.basename(dirPath);
  const rootName = renameDotPrefixed ? applyDotRename(origRootName) : origRootName;
  if (renameDotPrefixed && rootName !== origRootName) {
    renames.push({ from: origRootName, to: rootName });
  }

  function addDir(fsPath, zipPath) {
    const entries = fs.readdirSync(fsPath, { withFileTypes: true });
    for (const entry of entries) {
      // Skip files in IGNORED_FILES, that must not appear in the zip.
      if(IGNORED_FILES.has(entry.name)) continue;

      const entryName = renameDotPrefixed ? applyDotRename(entry.name) : entry.name;
      if (renameDotPrefixed && entryName !== entry.name) {
        const fromPath = zipPath ? `${zipPath}/${entry.name}` : entry.name;
        const toPath   = zipPath ? `${zipPath}/${entryName}` : entryName;
        renames.push({ from: fromPath, to: toPath });
      }
      const fullPath = path.join(fsPath, entry.name);
      const entryZipPath = zipPath ? `${zipPath}/${entryName}` : entryName;
      if (entry.isDirectory()) {
        zip.folder(entryZipPath);
        addDir(fullPath, entryZipPath);
      } else if (entry.isFile()) {
        zip.file(entryZipPath, fs.readFileSync(fullPath));
      }
      // Symlinks are skipped — the upload validator flags them via unixPermissions.
    }
  }

  addDir(dirPath, rootName);

  // Update path references inside .js/.yml/.yaml files to use renamed paths.
  const refUpdates = await applyRenamesInTextFiles(zip, renames);

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, renames, refUpdates };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractRunFlowRefs(docs) {
  const refs = [];
  function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node && typeof node === "object") {
      if (node.runFlow) {
        if (typeof node.runFlow === "string") refs.push(node.runFlow);
        else if (node.runFlow.file) refs.push(node.runFlow.file);
      }
      Object.values(node).forEach(walk);
    }
  }
  docs.forEach(walk);
  return refs;
}

function extractClassname(filepath) {
  if (!filepath || typeof filepath !== "string") return null;
  const base = path.basename(filepath);
  if (!base || typeof base.endsWith !== "function") return null;
  if (base.endsWith(".yaml")) return base.slice(0, -5);
  if (base.endsWith(".yml")) return base.slice(0, -4);
  return base;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════

async function validateTestSuite(zipBuffer, zipFilename, buildParams = {}, options = {}) {
  const { renameDotPrefixed = false } = options;

  // Rewrite the zip in-memory to:
  //   1. Remove any entries whose path contains a segment in IGNORED_FILES.
  //   2. If renameDotPrefixed is set, rename dot-prefixed path segments.
  let effectiveBuffer = zipBuffer;
  const renames = []; // { from, to } pairs collected during rename
  try {
    const srcZip = await JSZip.loadAsync(zipBuffer);
    const newZip = new JSZip();
    for (const [name, entry] of Object.entries(srcZip.files)) {
      // Skip entries that contain an IGNORED_FILES segment anywhere in their path.
      const segments = name.split("/");
      if (segments.some((s) => IGNORED_FILES.has(s))) continue;

      const newName = renameDotPrefixed ? renameDotPrefixedPath(name) : name;
      if (renameDotPrefixed && newName !== name) {
        renames.push({ from: name, to: newName });
      }
      if (entry.dir) {
        newZip.folder(newName);
      } else {
        const content = await entry.async("nodebuffer");
        newZip.file(newName, content);
      }
    }

    // Update path references inside .js/.yml/.yaml files to use renamed paths.
    if (renameDotPrefixed) {
      const refUpdates = await applyRenamesInTextFiles(newZip, renames);
      options._refUpdates = refUpdates;
    }

    effectiveBuffer = await newZip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  } catch (e) {
    // If we can't rewrite, fall through — validateUpload will catch the parse error.
  }

  const uploadResult = await validateUpload(effectiveBuffer, zipFilename);
  const buildResult = validateBuildParams(buildParams);

  // Only run dry-run if the zip was parseable (upload parse failure returns early
  // from validateUpload, so dryRun would also fail — skip it in that case).
  const zipParseFailed = uploadResult.errors.some(
    (e) => e.code === "BROWSERSTACK_INVALID_TESTSUITE" && e.message.startsWith("Cannot parse zip")
  );
  const dryRunResult = zipParseFailed
    ? null
    : await simulateDryRun(effectiveBuffer, {
        execute: buildParams.execute,
        rootFolder: buildParams.rootFolder,
      });

  return {
    phase1_upload: uploadResult.summary(),
    phase2_build: buildResult.summary(),
    phase3_dryRun: dryRunResult ? dryRunResult.summary() : null,
    overallValid:
      uploadResult.isValid &&
      buildResult.isValid &&
      (dryRunResult ? dryRunResult.isValid : true),
    renames,
    refUpdates: options._refUpdates || [],
    effectiveBuffer,
  };
}

module.exports = {
  validateUpload,
  validateBuildParams,
  simulateDryRun,
  validateTestSuite,
  directoryToZipBuffer,
  ValidationResult,
  renameDotPrefixedPath,
};