/**
 * Output formatters for the BrowserStack Maestro Validator.
 * Auto-detects the CI environment and emits native annotations.
 */

const fs = require("fs");
const path = require("path");

function detectFormat() {
  if (process.env.GITHUB_ACTIONS === "true") return "github";
  if (process.env.BITBUCKET_BUILD_NUMBER) return "bitbucket";
  return "text";
}

// ─── Text Reporter ───────────────────────────────────────────────────────────

function reportText(results) {
  const lines = [];
  const phases = [
    ["Phase 1 — Upload", results.phase1_upload],
    ["Phase 2 — Build API", results.phase2_build],
    ["Phase 3 — Dry Run", results.phase3_dryRun],
  ];

  for (const [name, phase] of phases) {
    if (!phase) continue;
    lines.push(`\n═══ ${name} ═══`);
    lines.push(`  Status: ${phase.valid ? "✅ PASS" : "❌ FAIL"}`);
    lines.push(`  Errors: ${phase.errorCount}   Warnings: ${phase.warningCount}`);

    for (const err of phase.errors) {
      const loc = err.file ? ` [${err.file}]` : "";
      lines.push(`  ❌ ${err.code}${loc}: ${err.message}`);
    }
    for (const warn of phase.warnings) {
      const loc = warn.file ? ` [${warn.file}]` : "";
      lines.push(`  ⚠️  ${warn.code}${loc}: ${warn.message}`);
    }
  }

  lines.push(`\n═══ OVERALL ═══`);
  lines.push(results.overallValid ? "✅ Valid" : "❌ Invalid");
  return lines.join("\n");
}

// ─── GitHub Actions Reporter ─────────────────────────────────────────────────

function reportGithub(results) {
  const phases = [
    ["upload", results.phase1_upload],
    ["build", results.phase2_build],
    ["dryRun", results.phase3_dryRun],
  ];

  for (const [phaseName, phase] of phases) {
    if (!phase) continue;
    for (const err of phase.errors) {
      const file = err.file ? `file=${err.file},` : "";
      const title = `Maestro [${phaseName}] ${err.code}`;
      const msg = err.message.replace(/\n/g, "%0A");
      console.log(`::error ${file}title=${title}::${msg}`);
    }
    for (const warn of phase.warnings) {
      const file = warn.file ? `file=${warn.file},` : "";
      const title = `Maestro [${phaseName}] ${warn.code}`;
      const msg = warn.message.replace(/\n/g, "%0A");
      console.log(`::warning ${file}title=${title}::${msg}`);
    }
  }

  // Step summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = buildMarkdownSummary(results);
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }

  // Set outputs
  if (process.env.GITHUB_OUTPUT) {
    const errorCount = phases.reduce(
      (sum, [, p]) => sum + (p ? p.errorCount : 0), 0
    );
    const warningCount = phases.reduce(
      (sum, [, p]) => sum + (p ? p.warningCount : 0), 0
    );
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `valid=${results.overallValid}\n` +
      `error-count=${errorCount}\n` +
      `warning-count=${warningCount}\n`
    );
  }

  return reportText(results);
}

function buildMarkdownSummary(results) {
  const lines = ["# 🧪 Maestro Test Suite Validation\n"];
  lines.push(`**Result:** ${results.overallValid ? "✅ Valid" : "❌ Invalid"}\n`);

  const phases = [
    ["Phase 1 — Upload", results.phase1_upload],
    ["Phase 2 — Build API", results.phase2_build],
    ["Phase 3 — Dry Run", results.phase3_dryRun],
  ];

  lines.push("| Phase | Status | Errors | Warnings |");
  lines.push("|---|---|---|---|");
  for (const [name, phase] of phases) {
    if (!phase) {
      lines.push(`| ${name} | ⏭️ Skipped | — | — |`);
      continue;
    }
    const status = phase.valid ? "✅ Pass" : "❌ Fail";
    lines.push(`| ${name} | ${status} | ${phase.errorCount} | ${phase.warningCount} |`);
  }

  for (const [name, phase] of phases) {
    if (!phase || (phase.errors.length === 0 && phase.warnings.length === 0)) continue;
    lines.push(`\n## ${name}\n`);
    for (const err of phase.errors) {
      lines.push(`- ❌ **${err.code}**${err.file ? ` (\`${err.file}\`)` : ""}: ${err.message}`);
    }
    for (const warn of phase.warnings) {
      lines.push(`- ⚠️ **${warn.code}**${warn.file ? ` (\`${warn.file}\`)` : ""}: ${warn.message}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ─── Bitbucket Pipelines Reporter ────────────────────────────────────────────

function reportBitbucket(results) {
  const text = reportText(results);
  console.log(text);

  const storageDir = process.env.BITBUCKET_PIPE_STORAGE_DIR || process.cwd();
  const reportPath = path.join(storageDir, "maestro-validation-report.json");
  try {
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`\n📄 Report written to: ${reportPath}`);
  } catch (e) {
    console.warn(`Could not write report: ${e.message}`);
  }

  return text;
}

// ─── JSON Reporter ───────────────────────────────────────────────────────────

function reportJson(results) {
  return JSON.stringify(results, null, 2);
}

// ─── Dispatcher ──────────────────────────────────────────────────────────────

function report(results, format) {
  const fmt = format || detectFormat();
  switch (fmt) {
    case "github":    return reportGithub(results);
    case "bitbucket": return reportBitbucket(results);
    case "json":      return reportJson(results);
    case "text":
    default:          return reportText(results);
  }
}

module.exports = { report, detectFormat };