# Universal Makefile for the ledgerpi project.
# Same surface for dev + CI. Run `make help` for the target list.
#
# ledgerpi is a TypeScript pi extension plus a Claude Code plugin. pi loads the
# extension directly; the plugin needs the compiled ledgerctl on PATH. There are no
# cross-compile targets or release artifacts. The gate is tsc typecheck + Biome
# lint/format + the test suites.

DIST         := dist
VERSION      := $(shell cat VERSION 2>/dev/null || echo 0.0.0)
# Recursive (not :=) so a single `make bootstrap check` sees node_modules after bootstrap installs it.
NPM_BIN      = $(if $(wildcard node_modules/.bin),node_modules/.bin/,)
EXTRA_CLEAN  := node_modules bin
PREFIX       ?= $(HOME)/.local

.PHONY: help bootstrap build install uninstall typecheck test test-plugin fmt fmt-check lint check version clean

.DEFAULT_GOAL := help

help: ## Print this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} \
	  /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

version: ## Print just the version.
	@echo $(VERSION)

bootstrap: ## Install dev tooling from the lockfile (typescript + biome + pi types). Idempotent.
	npm ci
	@echo "bootstrap complete"

build: ## Compile bin/ledgerctl for the Claude Code plugin. pi needs no build step.
	bun build --compile packages/claude/src/bin/ledgerctl.ts --outfile bin/ledgerctl

install: build ## Install ledgerctl into $(PREFIX)/bin.
	install -d $(PREFIX)/bin
	install -m 0755 bin/ledgerctl $(PREFIX)/bin/ledgerctl

uninstall: ## Remove ledgerctl from $(PREFIX)/bin.
	rm -f $(PREFIX)/bin/ledgerctl

typecheck: ## tsc --noEmit against the pi type defs.
	$(NPM_BIN)tsc -p tsconfig.json --noEmit

test: typecheck ## Typecheck, then drive the extension hooks and ledgerctl against stubs and exercise the review-ledgers skill recipes and the worker-thinking bench harness end to end.
	node --experimental-strip-types test/hooks.test.ts
	node --experimental-strip-types test/review-ledgers.test.ts
	node --experimental-strip-types test/claude.test.ts
	node --experimental-strip-types test/fanout.test.ts
	node --experimental-strip-types test/bench-worker-thinking.test.ts
	node --experimental-strip-types test/concurrency-bench.test.ts
	node --experimental-strip-types test/fanout-bench.test.ts

test-plugin: ## Validate the Claude Code plugin, typecheck its mod and run its tests. Needs the claude CLI, so CI does not run it.
	claude plugin validate packages/claude
	claude plugin test packages/claude
	@if [ -f packages/claude/.claude-plugin/types/tsconfig.json ]; then \
		$(NPM_BIN)tsc -p packages/claude; \
	else \
		echo "SKIPPED mod typecheck: its types appear once a session has loaded the plugin"; \
	fi

fmt: ## Format + fix lint with Biome (format + lint + import sorting).
	$(NPM_BIN)biome check --write .

fmt-check: ## Biome CI gate: format + lint + import sorting, warnings as errors.
	$(NPM_BIN)biome ci .

lint: ## Lint only with Biome, warnings as errors.
	$(NPM_BIN)biome lint --error-on-warnings .

check: fmt-check test ## Biome CI gate (format+lint+imports) + typecheck. Pre-push gate.

clean: ## Remove node_modules, dist, and bin.
	rm -rf $(DIST) $(EXTRA_CLEAN)
