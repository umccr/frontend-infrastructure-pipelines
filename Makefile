.PHONY: install lint lint-fix format format-check check test fix audit-fix

install:
	@pnpm install
	@pre-commit install

lint:
	@pnpm lint

lint-fix:
	@pnpm lint:fix

format:
	@pnpm format

format-check:
	@pnpm format:check

check: lint format-check
	@pnpm audit
	@if command -v pre-commit >/dev/null 2>&1; then pre-commit run --all-files; else echo "pre-commit not installed; skipping pre-commit hooks"; fi

test:
	@pnpm test

fix: lint-fix format

audit-fix:
	@pnpm audit --fix=override
