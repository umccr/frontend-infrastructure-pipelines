# Hub — portal frontend at `/hub/`

Context for how Hub (`umccr/hub`) is served on the shared portal and what it must do to stay
correct there. Hub is a Vite SPA.

## How it fits the portal

Hub is hosted as static files on S3 behind the portal's CloudFront distribution, under the `/hub/`
path prefix, alongside OrcaUI (`/`), OrcaUI v2 (`/v2/`) and OrcaHouse (`/orcahouse/`). Its pipeline
(`HubAppCICDPipeline`) lives in `umccr/frontend-infrastructure-pipelines`: it builds once and promotes
the same artifact from dev to prod, so nothing environment-specific may be baked into the build.

`base: '/hub/'` and the `env.js` / `window.config` runtime-config mechanism are the foundation. The
notes below are the things that must hold for Hub to work on a shared domain — each fails quietly
(wrong result, not a build error) if broken.

## Requirements on a shared domain

**All asset paths must be base-path-prefixed.** Vite rewrites URLs in `index.html` but not string
literals in TSX or files copied verbatim from `public/`, so a bare `/assets/…` resolves against the
portal root — a different app's bucket. Prefix them with `import.meta.env.BASE_URL` (e.g. the sign-in
logo), and keep `public/manifest.json` icon paths relative.

**`window.config` merges per key.** Runtime `env.js` values override build-time values key by key, and
empty runtime values don't mask a usable build-time fallback. A whole-object replace would let a
partially populated `env.js` silently revert every key to build-time values — on the portal that is a
different environment's Cognito settings. A `missingEnv()` helper backs this.

**Missing sign-in config is reported, not silent.** A missing Cognito value otherwise surfaces only as
a hosted-UI redirect to `undefined.auth.undefined.amazoncognito.com`. Config load logs a single named
error listing the missing keys. It must **not** throw — `config.ts` runs at module load, so throwing
would white-screen the app.

**Sign-in returns to Hub, not the portal root.** The OAuth redirect is derived from
`window.location.origin` + `import.meta.env.BASE_URL`, not from `VITE_OAUTH_REDIRECT_IN`/`_OUT` (which
name the portal root). This is correct in every environment and on both prod hostnames with no
configuration.

> This requires `https://portal.<stage>.umccr.org/hub/` to be a registered callback URL on the Cognito
> app client — handled in `umccr/infrastructure` `cognito_aai`, and **applied to an environment before
> Hub reaches it**, or sign-in is rejected with `redirect_mismatch`.

## Housekeeping expectations

- No `public/_redirects` (Netlify syntax, inert on CloudFront; the portal's CloudFront Function does
  the SPA fallback).
- `.nvmrc` pinned to 24, aligned with CI and the portal pipeline.
- No hand-rolled `make deploy-dev` / `aws s3 cp` deploy. Deployment is owned by the pipeline; a manual
  copy would skip the `--delete` prune and the `Cache-Control` headers that keep an open session
  working through a deploy, and would rewrite every portal app's `env.js`.

## Tests

`src/utils/__tests__/env.test.ts` covers the `window.config` merge: runtime-over-build-time, per-key
merge, and empty-value handling. A real `pnpm build` should show every absolute URL in
`build/index.html` `/hub/`-prefixed (including `/hub/env.js`), the manifest icon resolving under
`/hub/`, no un-prefixed `/assets/…` in the bundle, the OAuth redirect building as `${origin}/hub/`, and
no `VITE_OAUTH_REDIRECT_*` references.

## Pipeline stack

[`lib/portal/hub/app-pipeline-stack.ts`](../../lib/portal/hub/app-pipeline-stack.ts) defines
`HubAppPipelineStack`, the `HubAppCICDPipeline` that builds [`umccr/hub`](https://github.com/umccr/hub)
and deploys it to `portal.<stage>.umccr.org/hub/`. It is a thin configuration wrapper around the shared
[`PortalAppPipeline`](../../lib/portal/infra/app-pipeline.ts) construct:

```ts
new PortalAppPipeline(this, 'HubAppPipeline', {
  app: HUB_APP, // registry entry in lib/portal/infra/apps.ts
  namePrefix: 'Hub',
  buildCommands: ['pnpm build'],
  artifactBaseDirectory: 'build/', // React SPA output, synced to s3://<bucket>/hub/
});
```

Hosting (S3 bucket, CloudFront behaviour, DNS, `env.js`) is **not** defined here. It belongs to the
shared portal infrastructure in [`lib/portal/infra/`](../../lib/portal/infra/); Hub's registry entry is
`HUB_APP` in [`lib/portal/infra/apps.ts`](../../lib/portal/infra/apps.ts), which also decides which
stages exist — currently beta and prod, with no gamma.

For the full app-repo checklist (base path, artifact directory, routing mode, `env.js`, caching) and
why each item matters, see [`docs/portal/onboarding-an-app.md`](../portal/onboarding-an-app.md).

## Deploying

The pipeline stack is **not** self-mutating: `cdk deploy` updates the pipeline definition without
starting a release. A release runs when `umccr/hub` `main` changes. Deploy the pipeline from the
toolchain account:

```sh
pnpm cdk diff HubAppPipeline    # review the change first
pnpm cdk deploy HubAppPipeline
```

## Related

- `umccr/frontend-infrastructure-pipelines` — portal hosting + `HubAppCICDPipeline` (this repo).
- `umccr/infrastructure` `cognito_aai` — the `/hub/` callback URL. **Apply before Hub deploys.**
