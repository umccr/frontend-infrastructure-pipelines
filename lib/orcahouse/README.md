# OrcaHouse app pipeline

[`app-pipeline-stack.ts`](./app-pipeline-stack.ts) defines `OrcaHouseAppPipelineStack`, the CI/CD pipeline that builds
[`umccr/orcahouse-ui`](https://github.com/umccr/orcahouse-ui) and deploys it to
`portal.<stage>.umccr.org/orcahouse/`.

It is a thin configuration wrapper around the shared
[`PortalAppPipeline`](../portal/app-pipeline.ts) construct.

Hosting (S3 bucket, CloudFront behaviour, DNS, `env.js`) is **not** defined here. It belongs to the
shared portal stack in [`lib/portal/`](../portal/); this app's entry is `ORCAHOUSE_APP` in
[`lib/portal/apps.ts`](../portal/apps.ts), which also decides which stages exist. Currently beta and
prod, with no gamma.

## Required in `umccr/orcahouse-ui`

- `output: 'export'` and `trailingSlash: true` in `next.config`, so the build emits a static site
  in `out/` with one HTML file per route. `.next/` is a build cache and cannot be served from S3.
- `basePath: '/orcahouse'` and a matching `assetPrefix`.

See [`docs/portal/onboarding-an-app.md`](../../docs/portal/onboarding-an-app.md) for the full
checklist and why each item matters.

## Deploying

The pipeline stack is not self-mutating, so deploying it updates the pipeline definition without
starting a release:

```sh
pnpm cdk diff OrcaHouseAppPipeline
pnpm cdk deploy OrcaHouseAppPipeline
```
