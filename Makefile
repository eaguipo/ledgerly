# Ledgerly — local infra workflow.
# Run `make` (or `make help`) to see targets.

SHELL := /bin/bash
CLUSTER := ledgerly
NS := ledgerly
CHART := deploy/helm/ledgerly
K3D_CFG := deploy/k3d/cluster.yaml

.DEFAULT_GOAL := help

## ───────────────────────── setup ─────────────────────────

.PHONY: prereqs
prereqs: ## Install the toolchain (colima, k3d, kubectl, helm, tilt) via Homebrew
	brew install colima docker k3d kubectl helm tilt

.PHONY: hosts
hosts: ## Add ledgerly.local + registry hostnames to /etc/hosts (needs sudo)
	@grep -q 'ledgerly.local' /etc/hosts || echo '127.0.0.1 ledgerly.local' | sudo tee -a /etc/hosts >/dev/null
	@grep -q 'k3d-registry.localhost' /etc/hosts || echo '127.0.0.1 k3d-registry.localhost' | sudo tee -a /etc/hosts >/dev/null
	@echo "hosts entries ok"

.PHONY: runtime
runtime: ## Ensure the container runtime (colima) is running
	@colima status >/dev/null 2>&1 || colima start --cpu 4 --memory 6 --disk 40

## ─────────────────────── cluster ─────────────────────────

.PHONY: cluster-up
cluster-up: runtime ## Create the k3d cluster + install ingress-nginx
	@k3d cluster list | grep -q '^$(CLUSTER)' || k3d cluster create --config $(K3D_CFG)
	@$(MAKE) ingress
	@echo "cluster '$(CLUSTER)' ready"

.PHONY: ingress
ingress: ## Install/upgrade ingress-nginx into the cluster
	helm upgrade --install ingress-nginx ingress-nginx \
		--repo https://kubernetes.github.io/ingress-nginx \
		--namespace ingress-nginx --create-namespace \
		--set controller.service.type=LoadBalancer \
		--set controller.admissionWebhooks.enabled=false
	kubectl -n ingress-nginx rollout status deploy/ingress-nginx-controller --timeout=180s

.PHONY: cluster-down
cluster-down: ## Delete the k3d cluster
	k3d cluster delete $(CLUSTER)

## ─────────────────────── helm ────────────────────────────

.PHONY: helm-deps
helm-deps: ## Vendor the reusable service subchart into the umbrella
	helm dependency update $(CHART)

.PHONY: lint
lint: helm-deps ## helm lint the umbrella chart
	helm lint $(CHART)

.PHONY: template
template: helm-deps ## Render the umbrella chart to stdout (no cluster needed)
	helm template ledgerly $(CHART) --namespace $(NS)

.PHONY: deploy
deploy: helm-deps ## Install/upgrade via Helm using values.local.yaml (non-Tilt path)
	helm upgrade --install ledgerly $(CHART) \
		--namespace $(NS) --create-namespace \
		-f $(CHART)/values.local.yaml

## ─────────────────────── dev loop ────────────────────────

.PHONY: dev
dev: helm-deps ## Start the Tilt live-reload dev loop
	tilt up

.PHONY: dev-down
dev-down: ## Stop Tilt and remove its resources
	tilt down

## ─────────────────────── inspect ─────────────────────────

.PHONY: status
status: ## Show pods/services/ingress in the ledgerly namespace
	kubectl -n $(NS) get pods,svc,ingress

.PHONY: logs
logs: ## Tail the web deployment logs
	kubectl -n $(NS) logs -l app.kubernetes.io/name=web -f

.PHONY: help
help: ## Show this help
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'
