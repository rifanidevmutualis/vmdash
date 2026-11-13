SHELL := /bin/bash
NODE_BIN := $(CURDIR)/.tools/node/bin
NPM := $(if $(wildcard $(NODE_BIN)/npm),$(NODE_BIN)/npm,npm)
CARGO := $(if $(wildcard $(HOME)/.cargo/bin/cargo),$(HOME)/.cargo/bin/cargo,cargo)

.PHONY: web build run dev install clean

web:
	cd web && $(NPM) install --no-audit --no-fund && $(NPM) run build

build: web
	$(CARGO) build --release

run:
	$(CARGO) run --release

dev:
	@echo "terminal 1: $(CARGO) run"
	@echo "terminal 2: cd web && npm run dev"

install: build
	mkdir -p $(HOME)/.local/bin
	cp target/release/vmdash $(HOME)/.local/bin/vmdash
	@echo "installed $(HOME)/.local/bin/vmdash"

clean:
	$(CARGO) clean
	rm -rf web/dist web/node_modules
