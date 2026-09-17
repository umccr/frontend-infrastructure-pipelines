# UI v2 deployment strategy (dual bucket + `/v2/` URL)

> Moved from `OrcaBus/orca-ui` `docs/ui-v2-deployment-strategy.md`.
>
> **This document records why UI v2 was hosted at `/v2/`.** The mechanism it originally described,
> a v1 bucket plus an optional v2 bucket, has since been generalised: the portal now hosts an
> arbitrary set of apps on path prefixes, driven by [`lib/portal/apps.ts`](../../lib/portal/apps.ts).
> For how routing, SPA rewrites and `env.js` work today, see
> [`docs/portal/README.md`](../portal/README.md).

## Goals

- **Same hostname, path separation**: developers use the existing portals (for example
  `portal.dev.umccr.org` / `orcaui.dev.umccr.org`) and open v2 at **`/v2/`**, including nested client
  routes under `/v2/...`.
- **Independent artifacts**: v2 build output lives in a **dedicated S3 bucket**, so v1 and v2 can be
  built and deployed on different schedules from different pipelines.
- **Shared edge**: one **CloudFront distribution** serves both; no second DNS name is required.

These goals held up, and they are now the model for every portal app rather than a v2 special case.

## What v2 established

| Concern                   | Then (v1 + optional v2)                          | Now (any number of apps)                                     |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------ |
| S3 bucket                 | `orcaui-cloudfront-*`, `orcaui-v2-cloudfront-*`  | One bucket per app, named `<app>-cloudfront-<account-id>`    |
| CloudFront                | Default → v1, one additional behaviour `/v2/*`   | Default → root app, one additional behaviour per path prefix |
| SPA routing               | One function with a hardcoded `/v2` branch       | One function with a synth-generated prefix allowlist         |
| Runtime config (`env.js`) | `env.js` on v1, mirrored to `v2/env.js` when set | `<prefix>/env.js` per app, from `PORTAL_APP_TARGETS`         |
| Enabling a stage          | Set `v2CloudFrontBucketName` for that stage      | Add the stage to the app's `bucketName` in the registry      |

## Stage rollout

UI v2 is hosted in beta, gamma and prod. Bucket names come from `ORCAUI_V2_APP` in
[`lib/portal/apps.ts`](../../lib/portal/apps.ts):

- **Beta**: `orcaui-v2-cloudfront-843407916570`
- **Gamma**: `orcaui-v2-cloudfront-455634345446`
- **Prod**: `orcaui-v2-cloudfront-472057503814`

Removing a stage from `bucketName` omits that stage's bucket, its `/v2/*` CloudFront behaviour, its
SPA rewrite entry and its `env.js` target.

## Request flow

1. Browser requests `https://portal.dev.umccr.org/v2/workflows`, which has no file extension.
2. CloudFront matches **`/v2/*`** and forwards to the **v2 origin**, S3 via OAI.
3. The **CloudFront Function**
   ([`lib/portal/lambda/spa-rewrite.js`](../../lib/portal/lambda/spa-rewrite.js)) maps the URI to
   **`/v2/index.html`** so the SPA shell loads.
4. Requests under `/v2/` that do carry a known extension, for example `.js`, `.css` or `.png`, are
   **not** rewritten and are fetched by key from the v2 bucket.

**Artifact layout expectation**: the deploy pipeline places the v2 app under the **`v2/` prefix**
inside the v2 bucket (`v2/index.html`, `v2/assets/...`), consistent with `v2/env.js`.

## Open question

`v2` is a version, not an app name, so `/v2/` becomes an odd permanent URL once v2 is the default UI.
Tracked as
[future improvement 7](../portal/future-improvements.md#7-decide-what-happens-to-v2-when-orcaui-v2-becomes-the-default-ui).

## References

- [`docs/portal/README.md`](../portal/README.md) — current hosting, routing and runtime config.
- [`lib/portal/apps.ts`](../../lib/portal/apps.ts) — the app registry.
- [`lib/portal/infrastructure-stack.ts`](../../lib/portal/infrastructure-stack.ts) — buckets,
  CloudFront behaviours, Lambda env, IAM grants.
- [`lib/orcaui/v2-app-pipeline-stack.ts`](../../lib/orcaui/v2-app-pipeline-stack.ts) — build and
  `/v2/` sync for `OrcaBus/orca-ui-v2`.
