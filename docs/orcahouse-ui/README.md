# OrcaHouse — portal frontend at `/orcahouse/`

Context for how OrcaHouse (`umccr/orcahouse-ui`) is served on the shared portal and how it resolves its
API host at runtime. OrcaHouse is a Next.js static export.

## How it fits the portal

OrcaHouse is hosted as a Next.js static export (`output: 'export'`, `trailingSlash: true`) on S3 behind
the portal's CloudFront distribution, under the `/orcahouse/` path prefix, alongside OrcaUI (`/`), v2
(`/v2/`) and Hub (`/hub/`). Its pipeline (`OrcaHouseAppCICDPipeline`) lives in
`umccr/frontend-infrastructure-pipelines`: it builds once and promotes the same artifact from dev to
prod, so nothing environment-specific may be baked into the build.

The path is `/orcahouse/` (named after the app/product), not `/mart/` (which named a single feature,
the OrcaVault mart browser). `next/link` and `next/navigation` derive everything from `basePath`, so
the path is a one-constant change in `next.config.ts`. (The dbt model path `orcavault/models/mart/…` is
unrelated and stays.)

## Requirements on a shared domain

**API host derived from the hostname, not built in.** `MART_API_URL` in Next's `env` block inlines
into the client bundle — with one promoted artifact, a beta deploy would query the prod API. Instead:

- `src/lib/environment.ts` maps hostname → environment → `mart.<env>.umccr.org`. Unknown hostnames
  resolve to `dev`, so a mistyped host fails away from prod.
- `src/lib/apollo.ts` resolves the endpoint per request via `HttpLink`'s `uri` function. It cannot be a
  module-load constant, because `makeClient` also runs during static prerender where `window` is
  undefined.
- `MART_API_URL` stays for local development only, read server-side by the dev proxy.

> `mart.dev.umccr.org` does not exist yet, so on dev, queries surface an API error while sign-in and the
> catalogue shell work — intended, and better than the dev deployment reading production data. Local
> development points at prod with your own `MART_API_TOKEN`.

**`env.js` fetched from the app's own prefix.** `${BASE_PATH}/env.js`, not `/env.js` (which is the
domain root, i.e. OrcaUI's bucket). This matches what the portal's config Lambda writes per app.

**Sign-in returns to OrcaHouse, not the portal root.** The OAuth redirect is
`${window.location.origin}${BASE_PATH}/`, rather than read from the portal-root value in `env.js` / SSM.
This also makes the existing return-path logic (`orcahouse-ui.return-path`) effective, so users return
to the exact table they were on.

> Requires `https://portal.<stage>.umccr.org/orcahouse/` registered as a callback URL on the Cognito
> app client (`umccr/infrastructure` `cognito_aai`). **Apply before OrcaHouse deploys to an
> environment**, or sign-in is rejected with `redirect_mismatch`.

## Build expectations

A real `pnpm build` should show:

- `out/` with no nested `orcahouse/` directory, so syncing its contents to `s3://bucket/orcahouse/` is
  correct (no `/orcahouse/orcahouse/`).
- Every asset URL `/orcahouse/`-prefixed; per-route HTML at `out/index.html`, `out/404/index.html`,
  `out/_not-found/index.html` (matching the pipeline's `static-export` routing mode).
- `MART_API_URL` absent from `out/` entirely; only the derived `https://mart.${…}.umccr.org` template.
- The OAuth redirect building as `${origin}${"/orcahouse"}/`; no `VITE_/NEXT_PUBLIC_OAUTH_REDIRECT_*`
  reads.

`pnpm type-check`, `pnpm lint`, `pnpm format:check` should be clean.

## Pipeline stack

[`lib/portal/orcahouse/app-pipeline-stack.ts`](../../lib/portal/orcahouse/app-pipeline-stack.ts)
defines `OrcaHouseAppPipelineStack`, the `OrcaHouseAppCICDPipeline` that builds
[`umccr/orcahouse-ui`](https://github.com/umccr/orcahouse-ui) and deploys it to
`portal.<stage>.umccr.org/orcahouse/`. It is a thin configuration wrapper around the shared
[`PortalAppPipeline`](../../lib/portal/infra/app-pipeline.ts) construct:

```ts
new PortalAppPipeline(this, 'OrcaHouseAppPipeline', {
  app: ORCAHOUSE_APP, // registry entry in lib/portal/infra/apps.ts
  namePrefix: 'OrcaHouse',
  buildCommands: ['pnpm build'],
  artifactBaseDirectory: 'out/', // Next.js static export, NOT .next/
  additionalNeverCacheGlobs: ['*.txt'], // App Router RSC payloads, fetched by stable name
});
```

The required `next.config` for the static export (`output: 'export'`, `trailingSlash: true`,
`basePath`/`assetPrefix: '/orcahouse'`) is documented under
[Requirements on a shared domain](#requirements-on-a-shared-domain) above and in the
[onboarding guide](../portal/onboarding-an-app.md#nextjs-needs-a-static-export). `output: 'export'`
rules out SSR, API routes, middleware and ISR; if OrcaHouse needs any of them it cannot be hosted on
the portal distribution as-is.

Hosting (S3 bucket, CloudFront behaviour, DNS, `env.js`) is **not** defined here. It belongs to the
shared portal infrastructure in [`lib/portal/infra/`](../../lib/portal/infra/); OrcaHouse's registry
entry is `ORCAHOUSE_APP` in [`lib/portal/infra/apps.ts`](../../lib/portal/infra/apps.ts), which also
decides which stages exist — currently beta and prod, with no gamma.

## Deploying

The pipeline stack is **not** self-mutating: `cdk deploy` updates the pipeline definition without
starting a release. A release runs when `umccr/orcahouse-ui` `main` changes. Deploy the pipeline from
the toolchain account:

```sh
pnpm cdk diff OrcaHouseAppPipeline    # review the change first
pnpm cdk deploy OrcaHouseAppPipeline
```

## Related

- `umccr/frontend-infrastructure-pipelines` — portal hosting + `OrcaHouseAppCICDPipeline` (this repo).
- `umccr/infrastructure` `cognito_aai` — the `/orcahouse/` callback URL. **Apply before OrcaHouse
  deploys.**
