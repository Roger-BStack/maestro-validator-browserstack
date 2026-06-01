# BrowserStack Maestro Validator and Bundler

Pre-flight validator for **BrowserStack Maestro** test suites. It catches upload, build-API, and pre-execution scan errors **before** a session is dispatched to BrowserStack — saving session time and shortening the debug loop. This project also supports optional bundling and saving of validated zip files.

## BrowserStack Maestro Validator

When a Maestro test suite zip file does not meet [BrowserStack's structural requirements](https://www.browserstack.com/docs/app-automate/maestro/get-started/structure-your-tests), it can lead to repetitive unsuccessful execution attempts and extensive debugging time trying to figure out what went wrong.

This validator replicates the **exact validation pipeline** BrowserStack runs in three phases:

| Phase | Layer | What it checks |
|---|---|---|
| **1. Upload** | App Uploader | Zip format, size, symlinks, path traversal, malicious filenames, extension whitelist, YAML syntax, root folder structure |
| **2. Build API** | `/build` endpoint | `execute`, `tags`, `config`, sharding, env var format |
| **3. Pre-Execution Scan** | BrowserStack Maestro Session Runner | Flow discovery, hidden file exclusion, non-flow YAML detection, empty flows, path resolution, `runFlow` references, classname extraction nil guard, 120s timeout |


## BrowserStack Maestro Zip Bundler
When passing in a directory as the validation target, the validator creates a zip structure _**in memory**_ during the validation process. Use the optional `--save-zip-file` argument to save the validated zip structure to a file. By default the zip is written to the `./output` directory; use `--output-dir <path>` to specify a different location. (See below for more details.)

## Installation

```bash
npm install
```

## CLI Usage

```
maestro-validate <zip-file|directory> [options]
```

### Arguments

| Argument | Description |
|---|---|
| `<zip-file>` | Path to a `.zip` archive of the test suite |
| `<directory>` | Path to a local directory — packed into a zip in-memory before validation |

### Options

| Option | Description |
|---|---|
| `--params <file>` | Path to a JSON file containing build parameters (`execute`, `tags`, `env`, `config`, etc.) |
| `--format <fmt>` | Output format: `text`, `json`, `github`, or `bitbucket`. Auto-detected when not specified (see below) |
| `--output-dir <path>` | Directory for saving output files such as zip archives (default: `./output`) |
| `--fail-on-warnings` | Exit with code `1` if any warnings are present, even when there are no errors |
| `--save-zip-file` | When a directory is given and validation passes, save the in-memory zip to `<output-dir>/<dirname>.zip` |
| `--rename-dot-prefixed` | Rename any file or folder whose name starts with a single `.` by replacing the leading `.` with `_` (e.g. `.hidden` → `_hidden`, `.env` → `_env`). Applied when creating, loading, or saving the zip. Useful when your source tree contains dot-prefixed names that would otherwise trigger the `HIDDEN_DIRECTORY` validation error. |
| `--help`, `-h` | Print help and exit |

---

## Examples

### Validate a zip file
```bash
node bin/maestro-validate.js ./test-suite.zip
```

### Validate a local directory
```bash
node bin/maestro-validate.js ./test-suite-root-directory
```

### Validate a directory and save the resulting zip
```bash
node bin/maestro-validate.js ./test-suite-root-directory --save-zip-file
```

### Validate a directory and save the zip to a custom output directory
```bash
node bin/maestro-validate.js ./test-suite-root-directory --save-zip-file --output-dir ./dist
```

### Validate with optional build parameters
```bash
node bin/maestro-validate.js ./test-suite.zip --params build-params.json
```

### Validate and output JSON
```bash
node bin/maestro-validate.js ./test-suite.zip --format json
```

### Treat warnings as errors
```bash
node bin/maestro-validate.js ./test-suite-root-directory --fail-on-warnings
```

### Combined options
```bash
node bin/maestro-validate.js ./test-suite.zip --params build.json --format json --fail-on-warnings
```

### Rename dot-prefixed files and folders when validating a directory
```bash
node bin/maestro-validate.js ./my-test-suite/ --rename-dot-prefixed
```

### Rename dot-prefixed names and save the resulting zip
```bash
node bin/maestro-validate.js ./my-test-suite/ --rename-dot-prefixed --save-zip-file
```

### Rename dot-prefixed names in an existing zip file
```bash
node bin/maestro-validate.js ./test-suite.zip --rename-dot-prefixed
```

---

## --format option

The `--format` flag controls how validation results are rendered. When omitted, the format is **auto-detected** from the environment (see table below).

| Value | When to use | Output style |
|---|---|---|
| `text` | Local terminal (default) | Human-readable, coloured summary with per-phase sections |
| `json` | Scripting / programmatic consumption | Machine-readable JSON object written to stdout |
| `github` | GitHub Actions workflows | GitHub [workflow commands](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions) (`::error` / `::warning`) that appear as PR inline annotations and in the workflow summary |
| `bitbucket` | Bitbucket Pipelines | Bitbucket-compatible output; full results saved as a pipeline artifact at `maestro-validation-report.json` |

### Auto-detection rules

When `--format` is **not** supplied, the format is chosen automatically:

1. `GITHUB_ACTIONS=true` in the environment → `github`
2. `BITBUCKET_BUILD_NUMBER` set in the environment → `bitbucket`
3. Otherwise → `text`

### JSON output structure

When `--format json` is used, the validator writes a single JSON object to stdout:

```json
{
  "overallValid": true,
  "phase1_upload":  { "passed": true,  "errorCount": 0, "warningCount": 0, "issues": [] },
  "phase2_build":   { "passed": true,  "errorCount": 0, "warningCount": 0, "issues": [] },
  "phase3_dryRun":  { "passed": true,  "errorCount": 0, "warningCount": 1, "issues": [
    { "code": "HIDDEN_FILE_DETECTED", "severity": "warning", "message": "..." }
  ]}
}
```

This is useful for piping results into other tools or storing them as CI artifacts.

---

## --rename-dot-prefixed option

BrowserStack's upload validator rejects any file or folder whose name begins with a `.` (dot), reporting a `HIDDEN_DIRECTORY` error. This is common when a source tree contains files such as `.env`, `.flowconfig`, or folders like `.github`.

The `--rename-dot-prefixed` flag tells the validator to automatically rename these entries by replacing the single leading `.` with `_` before any validation or zip-saving takes place:

| Original name | Renamed to |
|---|---|
| `.hidden` | `_hidden` |
| `.env` | `_env` |
| `.flowconfig` | `_flowconfig` |
| `.github/` | `_github/` |

### How it works

- **Directory input**: dot-prefixed file and folder names are renamed _in-memory_ while the zip is being created. The files on disk are **not** modified.
- **Zip file input**: the zip is rewritten in-memory with all dot-prefixed entry path segments renamed before validation runs.
- **Reference rewriting**: after renaming, every `.js`, `.yml`, and `.yaml` file inside the zip is scanned for occurrences of the original (dot-prefixed) paths. Any found references are updated to use the renamed (underscore-prefixed) path, so `runFlow`, `config`, and other path references remain valid.
- **`--save-zip-file`**: when combined with `--rename-dot-prefixed`, the saved zip contains both the renamed entries and the updated references.

### Console output

For each rename and each reference update, a message is printed to stderr:

```
🔤  Renamed: ".hidden/login.yaml" → "_hidden/login.yaml"
📝  Updated reference in "flows/main.yaml": ".hidden/login.yaml" → "_hidden/login.yaml"
```

### Scope

Only a **single leading period** is replaced. Names that are exactly `.` or `..` are left unchanged. All other characters in the name are preserved. Reference rewriting applies to `.js`, `.yml`, and `.yaml` files only; binary files are not modified.

### Example

```bash
# Validate a directory that contains dot-prefixed files/folders
node bin/maestro-validate.js ./my-test-suite/ --rename-dot-prefixed

# Validate and save the renamed zip
node bin/maestro-validate.js ./my-test-suite/ --rename-dot-prefixed --save-zip-file --output-dir ./dist

# Rename dot-prefixed entries in an existing zip before validating
node bin/maestro-validate.js ./test-suite.zip --rename-dot-prefixed
```

---

## Build params JSON

```json
{
  "execute": ["flows/login.yaml", "flows/checkout.yaml"],
  "tags": { "includeTags": ["smoke"], "excludeTags": ["flaky"] },
  "env": { "APP_ENV": "staging" },
  "config": "config.yaml"
}
```

---

## GitHub Actions

```yaml
- uses: browserstack/maestro-ci-validator@v1
  with:
    zip: ./test-suite.zip
    params: ./build-params.json
    fail-on-warnings: false
```

Errors appear as PR inline annotations; full results in the workflow summary.

## Bitbucket Pipelines

Copy `bitbucket-pipelines.yml` into your repo root. The report is saved as an artifact at `maestro-validation-report.json`.

## Bitrise

Copy `bitrise.yml` into your repo root. Three workflows are provided:

| Workflow | Description |
|---|---|
| `validate-maestro` | Installs dependencies, runs the validator, and uploads `maestro-validation-report.json` as a build artifact |
| `upload-to-browserstack` | Uploads the test suite zip to BrowserStack via the Maestro API |
| `validate-and-upload` | Chains both workflows — validate first, then upload on success |

Set the following **Secrets** in your Bitrise app settings before running `upload-to-browserstack` or `validate-and-upload`:

| Secret | Description |
|---|---|
| `BROWSERSTACK_USERNAME` | Your BrowserStack username |
| `BROWSERSTACK_ACCESS_KEY` | Your BrowserStack access key |

Override the default input paths via **Env Vars** in your Bitrise app or workflow configuration:

| Env Var | Default | Description |
|---|---|---|
| `TEST_SUITE_ZIP` | `./test-suite.zip` | Path to the test suite zip file |
| `BUILD_PARAMS` | `./build-params.json` | Path to the build parameters JSON file |
| `FAIL_ON_WARNINGS` | `false` | Set to `true` to fail the step when warnings are present |

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | All validations passed |
| `1` | Validation failed (or warnings present with `--fail-on-warnings`) |
| `2` | Invalid CLI arguments or file error |

---

## Error code reference

### Phase 1 — Upload
| Code | Meaning |
|---|---|
| `BROWSERSTACK_INVALID_TESTSUITE` | Not a valid zip |
| `FILE_SIZE_EXCEEDED` | Zip > 1 GB |
| `SYMBOLIC_LINK` | Symlink detected |
| `PATH_TRAVERSAL` | `../` in zip entry |
| `MALICIOUS_FILE` | Disallowed characters in filename |
| `INVALID_FILE_TYPE` | Extension not in whitelist |
| `YAML_SYNTAX` | YAML parse error |

### Phase 2 — Build API
| Code | Meaning |
|---|---|
| `test_param_format_invalid` | Wrong type for `execute`/`config` |
| `test_param_content_invalid` | Disallowed characters in `execute` |
| `BROWSERSTACK_INVALID_TAGS_FORMAT` | `tags` not an object |
| `BROWSERSTACK_EMPTY_TAGS` | Empty `tags` |
| `BROWSERSTACK_DUPLICATE_TAGS` | Same tag in both include/exclude |
| `BROWSERSTACK_INVALID_SHARD_VALUES` | Shard missing required keys |
| `ENV_KEY_TOO_LONG` / `ENV_VALUE_TOO_LONG` | Env var length limit exceeded |

### Phase 3 — Dry Run
| Code | Meaning |
|---|---|
| `testsuite-parse-failed` | YAML parse exception during dry run |
| `testsuite-parse-empty` | Zero flow files discovered |
| `testsuite-no-tests-found-flowfile` | `execute` path not found |
| `HIDDEN_FILE_DETECTED` | Hidden file in zip (warning) |
| `NON_FLOW_FILE` | Non-flow YAML may cause Android failures (warning) |
| `EXTRACT_CLASSNAME_NIL` | Internal runner nil bug |

---

## License

MIT