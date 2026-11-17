# Agent guidance

## Keep it static

This repo is plain HTML, CSS, and browser-native JavaScript. Files run directly in the browser, with no build step. Preserve that architecture.

- Use browser APIs and dependency-free JavaScript.
- Keep scripts directly usable from the checked-in HTML; no compilation, transpilation, or bundling.
- Do not introduce Node.js, Bun, Deno, package managers, package manifests, dependencies, or framework tooling. This applies to development and tests too.

## Validation

- Validate changes in the browser. Serve the repo with `python3 -m http.server 8000` when a local server is needed and the environment permits it.
- Use `git diff --check` for whitespace checks. 
