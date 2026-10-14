# Kubernetes manifests

Plain manifests plus a Kustomization, one Deployment and Service per service, in namespace `travelduty`.

```bash
# Postgres connection for booking-service (e.g. an RDS instance)
kubectl create namespace travelduty
kubectl -n travelduty create secret generic travelduty-db --from-literal=url='postgres://user:pass@host:5432/travelduty'
kubectl -n travelduty create secret generic travelduty-admin --from-literal=token="$(openssl rand -hex 16)"   # optional

kubectl apply -k k8s/
kubectl -n travelduty port-forward svc/web 3000:80
```

Notes:

- Images are referenced as `travelduty/<service>:latest`. Build them with `docker compose build`, then retag and push
  to your registry (ECR, GHCR…) and update the `image:` fields or add an `images:` override to `kustomization.yaml`.
- `flight-service`, `hotel-service` and `payment-service` keep holds/payments in memory, so they run one replica.
  Scaling them out needs a shared store.
- The nginx config in `apps/web/nginx.conf` proxies `/api` to `gateway:8080`, which resolves inside the namespace.
- Every pod is annotated for Prometheus scraping on `/metrics`.
