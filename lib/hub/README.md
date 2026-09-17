# Hub app pipeline

[`app-pipeline-stack.ts`](./app-pipeline-stack.ts) defines `HubAppPipelineStack`, the CI/CD pipeline that builds
[`umccr/hub`](https://github.com/umccr/hub) and deploys it to
`portal.<stage>.umccr.org/hub/`.

It is a thin configuration wrapper around the shared
[`PortalAppPipeline`](../portal/app-pipeline.ts) construct.

Hosting (S3 bucket, CloudFront behaviour, DNS, `env.js`) is **not** defined here. It belongs to the
shared portal stack in [`lib/portal/`](../portal/); this app's entry is `HUB_APP` in
[`lib/portal/apps.ts`](../portal/apps.ts), which also decides which stages exist. Currently beta and
prod, with no gamma.

## Required in `umccr/hub`

- Vite `base: '/hub/'`, or the built asset URLs resolve against OrcaUI's bucket at the site root.

See [`docs/portal/onboarding-an-app.md`](../../docs/portal/onboarding-an-app.md) for the full
checklist and why each item matters.

## Deploying

The pipeline stack is not self-mutating, so deploying it updates the pipeline definition without
starting a release:

```sh
pnpm cdk diff HubAppPipeline
pnpm cdk deploy HubAppPipeline
```
