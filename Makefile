.PHONY: lint format check test install-hooks help frontend-install frontend-dev frontend-build

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

lint: ## Run eslint (and fix)
	yarn lint --fix

format: ## Run prettier formatter
	yarn format

check: ## Run lint and format checks (CI-safe)
	yarn lint
	yarn prettier --check .

test: ## Run tests (Jest)
	yarn test

install-hooks: ## Install husky hooks
	yarn prepare

frontend-install: ## Install dependencies
	yarn install

frontend-dev: ## Start dev server
	yarn dev

frontend-build: ## Build for production
	yarn build
