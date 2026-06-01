#!/usr/bin/env node
/**
 * CLI entrypoint for the BrowserStack Maestro Validator.
 *
 * Usage:
 *   maestro-validate <zip-file|directory> [--params <build-params.json>]
 *                                         [--format text|json|github|bitbucket]
 *                                         [--output-dir <path>]
 *                                         [--fail-on-warnings]
 *                                         [--rename-dot-prefixed]
 *                                         [--help]
 */

const fs = require("fs");
const path = require("path");
const { validateTestSuite, directoryToZipBuffer } = require("../src/validator");
const { report, detectFormat } = require("../src/reporters");

function printHelp() {
  console.log(`
Maestro CI Validator — pre-flight validation for BrowserStack Maestro test suites.

Usage:
  maestro-validate <zip-file|directory> [options]

Arguments:
  <zip-file>    Path to a .zip archive of the test suite
  <directory>   Path to a directory — it will be zipped in-memory before validation

Options:
  --params <file>          Path to JSON file with build params (execute, tags, env, etc.)
  --format <fmt>           Output format: text | json | github | bitbucket  (auto-detected)
  --output-dir <path>      Directory for saving output files (default: ./output)
  --fail-on-warnings       Exit with code 1 if warnings are present
  --save-zip-file          When a directory is given and validation passes, save the zip to <output-dir>/<dirname>.zip
  --rename-dot-prefixed    Rename any file or folder whose name starts with a single '.' by replacing
                           the leading '.' with '_' (e.g. '.hidden' → '_hidden'). Applied when
                           creating, loading, or saving the zip.
  --help, -h               Show this help

Exit codes:
   0  Validation passed
   1  Validation failed (or warnings if --fail-on-warnings)
   2  Invalid CLI arguments / file errors

Examples:
  maestro-validate ./test-suite.zip
  maestro-validate ./my-test-suite/
  maestro-validate ./test-suite.zip --params build.json --format json
  maestro-validate ./my-test-suite/ --fail-on-warnings
  maestro-validate ./my-test-suite/ --save-zip-file
  maestro-validate ./my-test-suite/ --save-zip-file --output-dir ./dist
  maestro-validate ./my-test-suite/ --rename-dot-prefixed
  maestro-validate ./my-test-suite/ --rename-dot-prefixed --save-zip-file
  maestro-validate ./test-suite.zip --rename-dot-prefixed
`);
}

function parseArgs(argv) {
  const args = { input: null, params: null, format: null, outputDir: null, failOnWarnings: false, saveZipFile: false, renameDotPrefixed: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h")         { args.help = true; continue; }
    if (a === "--params")                     { args.params = argv[++i]; continue; }
    if (a === "--format")                     { args.format = argv[++i]; continue; }
    if (a === "--output-dir")                 { args.outputDir = argv[++i]; continue; }
    if (a === "--fail-on-warnings")           { args.failOnWarnings = true; continue; }
    if (a === "--save-zip-file")              { args.saveZipFile = true; continue; }
    if (a === "--rename-dot-prefixed")        { args.renameDotPrefixed = true; continue; }
    if (a.startsWith("--")) {
      console.error(`Unknown option: ${a}`);
      process.exit(2);
    }
    if (!args.input) args.input = a;
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv);
  if (args.help) { printHelp(); process.exit(0); }

  if (!args.input) {
    console.error("Error: a zip file or directory path is required.\n");
    printHelp();
    process.exit(2);
  }

  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Error: path not found: ${inputPath}`);
    process.exit(2);
  }

  let buildParams = {};
  if (args.params) {
    const paramsPath = path.resolve(args.params);
    if (!fs.existsSync(paramsPath)) {
      console.error(`Error: params file not found: ${paramsPath}`);
      process.exit(2);
    }
    try {
      buildParams = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
    } catch (e) {
      console.error(`Error: cannot parse params JSON: ${e.message}`);
      process.exit(2);
    }
  }

  const stat = fs.statSync(inputPath);
  let zipBuffer;
  let zipFilename;

  if (stat.isDirectory()) {
    zipFilename = path.basename(inputPath) + ".zip";
    console.error(`🗜️  Packing directory "${path.basename(inputPath)}" into zip...`);
    try {
      const result = await directoryToZipBuffer(inputPath, { renameDotPrefixed: args.renameDotPrefixed });
      zipBuffer = result.buffer;
      if (args.renameDotPrefixed) {
        for (const { from, to } of (result.renames || [])) {
          console.error(`🔤  Renamed: "${from}" → "${to}"`);
        }
        for (const { file, from, to } of (result.refUpdates || [])) {
          console.error(`✏️   Updated reference in "${file}": "${from}" → "${to}"`);
        }
      }
    } catch (e) {
      console.error(`Error: failed to zip directory: ${e.message}`);
      process.exit(2);
    }
  } else {
    zipBuffer = fs.readFileSync(inputPath);
    zipFilename = path.basename(inputPath);
  }

  console.error(`🧪 Validating ${zipFilename}...`);
  const results = await validateTestSuite(zipBuffer, zipFilename, buildParams, { renameDotPrefixed: args.renameDotPrefixed });
  if (args.renameDotPrefixed && !stat.isDirectory()) {
    for (const { from, to } of (results.renames || [])) {
      console.error(`🔤  Renamed: "${from}" → "${to}"`);
    }
    for (const { file, from, to } of (results.refUpdates || [])) {
      console.error(`✏️   Updated reference in "${file}": "${from}" → "${to}"`);
    }
  }

  const output = report(results, args.format);
  if (args.format === "json" || detectFormat() === "text") {
    console.log(output);
  }

  const hasWarnings = [
    results.phase1_upload,
    results.phase2_build,
    results.phase3_dryRun,
  ].some((p) => p && p.warningCount > 0);

  // --save-zip-file: persist the in-memory zip to <outputDir>/<dirname>.zip,
  // but only when a directory was the input and validation found no errors.
  if (args.saveZipFile && stat.isDirectory()) {
    if (results.overallValid) {
      const outputDir = path.resolve(args.outputDir || "output");
      const outputPath = path.join(outputDir, zipFilename);
      try {
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(outputPath, zipBuffer);
        console.error(`💾 Zip saved to: ${outputPath}`);
      } catch (e) {
        console.error(`⚠️  Could not save zip file: ${e.message}`);
      }
    } else {
      console.error(`⚠️  Zip not saved — validation errors were detected.`);
    }
  }

  if (!results.overallValid) process.exit(1);
  if (args.failOnWarnings && hasWarnings) process.exit(1);
  process.exit(0);
})().catch((e) => {
  console.error(`Unexpected error: ${e.stack || e.message}`);
  process.exit(2);
});