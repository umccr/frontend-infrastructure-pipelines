# cognito_aai — per-app callback URLs for portal micro-frontends

Context for how Cognito sign-in is configured for the UMCCR portal frontends. The Terraform lives in
`umccr/infrastructure` under `terraform/stacks/cognito_aai`.

## How it fits the portal

The portal hosts several independently deployed frontends on one domain, each on its own URL path
prefix (`/`, `/v2/`, `/hub/`, `/orcahouse/`). They all share the `orcaui-app-<workspace>` Cognito app
client, so a single sign-in covers every app.

Cognito matches `redirect_uri` against `callback_urls` **exactly** — no prefix or wildcard matching.
Each app derives its own redirect from its base path (e.g. `https://portal.<stage>.umccr.org/hub/`),
so every one of those URLs must be registered on the app client, or sign-in is rejected with
`redirect_mismatch`.

## Layout

- `portal_apps.tf` — a single `portal_app_paths` local listing the path prefixes (`""`, `/v2/`,
  `/hub/`, `/orcahouse/`), shared by both app clients. This mirrors `pathPrefix` in `lib/portal/infra/apps.ts`
  of `umccr/frontend-infrastructure-pipelines`; the two must stay in step.
- `app_orcaui.tf` — `callback_urls` / `logout_urls` are the product of the workspace's origins and
  `portal_app_paths` (via `setproduct`). The `""` path reproduces the original single root URL, so the
  set is purely additive.
- `app_local.tf` — the localhost dev client gets the same per-path callbacks against
  `var.localhost_url`, so local development works at `http://localhost:3000/hub/` etc. The three local
  SSM redirect parameters reference `var.localhost_url` directly rather than `sort(callback_urls)[0]`,
  so they no longer depend on list ordering.

## Resulting URLs per workspace

| Workspace | `orcaui-app` callback + logout URLs                            |
| --------- | -------------------------------------------------------------- |
| dev       | `portal.dev.umccr.org` × `/`, `/v2/`, `/hub/`, `/orcahouse/`   |
| stg       | same shape on `portal.stg.umccr.org`                           |
| prod      | both `portal.prod.umccr.org` and `portal.umccr.org`, × 4 paths |

`/orcaui/oauth_redirect_*_stage` and the localhost redirect SSM parameters are unchanged in every
workspace. `orca-ui` v1 is unaffected — it still sends and receives the portal root.

## Operational notes

- Changes are additive and safe to apply on their own: the URLs are permitted but unused until each
  app ships its per-app redirect change.
- **Apply order matters the other direction:** register an environment's callback URLs _before_ that
  environment's app deploy, or sign-in breaks with `redirect_mismatch`. Recommended: dev → stg → prod,
  verifying in the Cognito console after each.
- A Terraform plan should show an **in-place update** to `aws_cognito_user_pool_client.orcaui_page_app_client`
  (and `portal_app_client_local` where `allow_cognito_app_local_map` is true). It must **never** show a
  `-/+` replace — replacing an app client reissues its client ID and signs everyone out.

## Related

- `umccr/frontend-infrastructure-pipelines` — portal hosting + app pipelines.
- `umccr/hub`, `umccr/orcahouse-ui` — the apps that send these redirect URLs.
