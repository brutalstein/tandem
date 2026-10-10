#!/usr/bin/env node
'use strict';
// Skill-selection relevance on a labeled dataset (no provider calls). The catalog is written for this study and
// modelled on common public skills; each task is labeled with the skills a worker should be pointed at, and most
// ordinary coding tasks are labeled with none: pointing at an irrelevant skill costs context and can mislead.
//   node bench/skills-eval.js [--out artifacts/skills-eval.json]
const fs = require('fs');
const path = require('path');
const { select } = require('../server/capabilities');

const sk = (name, description) => ({ name, description, whenToUse: '', platform: 'codex', implicit: true, path: `/skills/${name}/SKILL.md` });
const CATALOG = [
  sk('pdf', 'Read, extract text and tables from, merge, split, fill forms in and create PDF documents.'),
  sk('docx', 'Create and edit Word .docx documents: tracked changes, styles, tables, headers and templates.'),
  sk('xlsx', 'Create, read and edit Excel spreadsheets (.xlsx, .csv): formulas, formatting, charts, pivot tables.'),
  sk('playwright-e2e', 'Write and debug Playwright end-to-end browser tests: locators, fixtures, traces, flaky test triage.'),
  sk('react-components', 'Build React components with hooks, state management, props typing and accessibility.'),
  sk('postgres-migrations', 'Write safe PostgreSQL schema migrations: zero-downtime column changes, indexes, backfills, rollbacks.'),
  sk('docker-compose', 'Author Dockerfiles and docker-compose services: multi-stage builds, healthchecks, volumes, networking.'),
  sk('security-review', 'Review code for security vulnerabilities: injection, path traversal, authentication, secrets, unsafe deserialization.'),
  sk('terraform', 'Write and refactor Terraform infrastructure modules, state management, providers and plan review.'),
  sk('pytest-fixtures', 'Write pytest tests with fixtures, parametrization, monkeypatching and coverage for Python projects.'),
  sk('i18n', 'Internationalize applications: message catalogs, pluralization, locale formatting of dates and numbers, RTL.'),
  sk('github-actions', 'Write and debug GitHub Actions CI workflows: matrices, caching, secrets, reusable workflows.'),
  sk('openapi', 'Design and validate OpenAPI / Swagger REST API specifications and generate clients from them.'),
  sk('perf-profiling', 'Profile and optimize performance: CPU flame graphs, memory leaks, benchmarks, hot paths in Node.js and Python.'),
  sk('regex', 'Write, explain and test regular expressions safely, avoiding catastrophic backtracking (ReDoS).'),
  sk('git-history', 'Investigate git history: blame, bisect to find the commit that introduced a regression, recover lost work.'),
  sk('kubernetes', 'Write Kubernetes manifests and Helm charts: deployments, services, probes, resource limits, rollouts.'),
  sk('accessibility', 'Audit and fix web accessibility (WCAG): ARIA roles, keyboard navigation, contrast, screen readers.'),
  sk('rust-async', 'Write async Rust with tokio: tasks, channels, cancellation, Send/Sync errors and pinning.'),
  sk('sql-query-tuning', 'Tune slow SQL queries: EXPLAIN plans, indexes, join order, N+1 query detection in ORMs.'),
  sk('changelog', 'Write release notes and changelog entries following Keep a Changelog and semantic versioning.'),
  sk('csv-data-cleaning', 'Clean messy tabular data: malformed rows, encodings, deduplication, type coercion, with pandas.'),
];

// [task, [relevant skill names]]. Empty = no skill should be pointed at.
const DATA = [
  ['Extract the tables from invoice.pdf into a CSV file', ['pdf']],
  ['Merge the three monthly PDF reports into one PDF and add page numbers', ['pdf']],
  ['Fill in the onboarding PDF form fields from the user record', ['pdf']],
  ['Generate the quarterly report as a Word document with a table of contents', ['docx']],
  ['Add a formula column and conditional formatting to the sales spreadsheet export (xlsx)', ['xlsx']],
  ['The checkout Playwright test is flaky on CI; find out why and stabilize the locator', ['playwright-e2e']],
  ['Write an end-to-end browser test for the login flow', ['playwright-e2e']],
  ['Build a React dropdown component with keyboard navigation and ARIA roles', ['react-components', 'accessibility']],
  ['Add a NOT NULL column to the orders table in Postgres without downtime and backfill it', ['postgres-migrations']],
  ['Write a multi-stage Dockerfile for the API and a compose service with a healthcheck', ['docker-compose']],
  ['Review the upload handler for path traversal and injection vulnerabilities', ['security-review']],
  ['Refactor the Terraform VPC module into reusable submodules', ['terraform']],
  ['Add pytest fixtures and parametrized tests for the tax calculator', ['pytest-fixtures']],
  ['Translate the settings page and add plural forms for item counts in the message catalog', ['i18n']],
  ['The GitHub Actions workflow cache never hits; fix the cache key in the CI matrix', ['github-actions']],
  ['Write the OpenAPI specification for the orders REST API', ['openapi']],
  ['The report endpoint got slow; profile it and find the hot path', ['perf-profiling']],
  ['This email validation regex hangs on long input (catastrophic backtracking); fix it', ['regex']],
  ['Use git bisect to find the commit that broke the date parser', ['git-history']],
  ['Add liveness and readiness probes to the Kubernetes deployment manifest', ['kubernetes']],
  ['Fix the tokio task that is not Send when holding the mutex across an await', ['rust-async']],
  ['The dashboard query is slow; read the EXPLAIN plan and add the right index', ['sql-query-tuning']],
  ['Write the changelog entry for release 2.4.0', ['changelog']],
  ['Clean the customer CSV: fix encodings, drop duplicate rows and coerce the date column', ['csv-data-cleaning']],
  // Ordinary engineering tasks: no skill.
  ['Fix the off-by-one error in the pagination helper', []],
  ['Rename getUserById to findUser across the service and update callers', []],
  ['Implement slugify so the existing tests pass', []],
  ['The LRU cache evicts the wrong entry; fix it', []],
  ['Make mapLimit preserve input order', []],
  ['Add a retry with exponential backoff to the HTTP client', []],
  ['Why does the config loader ignore the environment variable?', []],
  ['Extract the duplicated email check into a shared module', []],
  ['Fix the race condition in the account deposit function', []],
  ['Add input validation to the createUser function', []],
  ['Update the README installation section', []],
  ['Convert the callback-based store API to also return promises', []],
  // Near misses: the words appear, the skill does not help.
  ['Change the color of the "Download PDF" button in the toolbar', []],
  ['Rename the docker_host config key to container_host', []],
  ['Fix the typo in the changelog link in the footer', []],
  ['Count how many tests are in the test folder', []],
];

// Written after the selector change above was tuned on DATA, and run once without further changes: an honest
// estimate for unseen phrasing. Reported separately; never tune against it.
const HELDOUT = [
  ['Split the scanned contract PDF into one file per page', ['pdf']],
  ['Turn the meeting notes into a .docx with tracked changes enabled', ['docx']],
  ['The pivot table in the budget spreadsheet shows wrong totals', ['xlsx']],
  ['Add an index concurrently and a rollback step to the Postgres migration', ['postgres-migrations']],
  ['Helm chart: set resource limits and a rolling update strategy for the worker deployment', ['kubernetes']],
  ['Our CI workflow should run the test matrix on Node 20 and 22 with npm caching', ['github-actions']],
  ['Screen reader users cannot reach the modal close button; fix keyboard focus', ['accessibility']],
  ['Memory grows on every request in the Node.js server; find the leak', ['perf-profiling']],
  ['Fix the null check in parseHeader', []],
  ['Add a --verbose flag to the CLI', []],
  ['Move the date helpers into utils/date.js', []],
  ['Make the build script print the elapsed time', []],
  ['Fix the failing unit test for the cart total', []],
  ['Rename the "Export to Excel" menu label to "Download"', []],
];

function evaluate(k = 3, data = DATA) {
  let tp = 0, fp = 0, fn = 0, fpOnNone = 0, none = 0, addedTok = 0, exact = 0;
  const misses = [], started = process.hrtime.bigint();
  for (const [task, want] of data) {
    const got = select(task, CATALOG, k).map(s => s.name);
    const hit = got.filter(n => want.includes(n)).length;
    tp += hit; fp += got.length - hit; fn += want.length - hit;
    if (!want.length) { none++; if (got.length) fpOnNone++; }
    if (got.length === want.length && hit === want.length) exact++; else misses.push({ task, want, got });
    addedTok += got.reduce((a, n) => a + Math.round((n.length + CATALOG.find(s => s.name === n).description.slice(0, 160).length + 30) / 4), 0);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    tasks: data.length, skills: CATALOG.length,
    precision: +(tp / Math.max(1, tp + fp)).toFixed(3), recall: +(tp / Math.max(1, tp + fn)).toFixed(3),
    exactMatch: +(exact / data.length).toFixed(3), falsePositiveRateOnNoSkillTasks: +(fpOnNone / none).toFixed(3),
    addedPromptTokensPerTask: +(addedTok / data.length).toFixed(1), selectionMsPerTask: +(ms / data.length).toFixed(3), misses,
  };
}

module.exports = { evaluate, CATALOG, DATA, HELDOUT };
if (require.main === module) {
  const r = { labeled: evaluate(), heldOut: evaluate(3, HELDOUT) };
  for (const [name, { misses, ...m }] of Object.entries(r)) {
    console.log(name, m);
    for (const x of misses) console.log(`  miss: ${JSON.stringify(x.task)} want ${JSON.stringify(x.want)} got ${JSON.stringify(x.got)}`);
  }
  const i = process.argv.indexOf('--out');
  if (i > 0) { fs.mkdirSync(path.dirname(process.argv[i + 1]), { recursive: true }); fs.writeFileSync(process.argv[i + 1], JSON.stringify(r, null, 2)); }
}
