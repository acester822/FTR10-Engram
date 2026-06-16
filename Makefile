.PHONY: help install dev build start clean

help:
	@echo "Engram JS cleanup commands"
	@echo "  make install  - install workspace dependencies"
	@echo "  make dev      - start JS server in development mode"
	@echo "  make build    - build JS package"
	@echo "  make start    - start built JS server"
	@echo "  make clean    - remove JS build output"

install:
	npm install

dev:
	npm run dev

build:
	npm run build

start:
	npm run start

clean:
	cd packages/engram-js && rm -rf dist

