# Portal: future improvements and TODOs

Deferred work on the portal micro-frontend platform. Everything here is a deliberate decision to
ship path-based routing for Hub and OrcaHouse first, not an oversight.

Each item states why it was deferred, what it costs to leave, and what doing it involves. Items are
independent unless a dependency is called out.

Current state is described in [`docs/portal/README.md`](./README.md).

## Contents

| #                                                                       | Item                                     | Priority | Blocked on                        |
| ----------------------------------------------------------------------- | ---------------------------------------- | -------- | --------------------------------- |
| [1](#1-move-orcaui-from--to-orcaui)                                     | Move OrcaUI from `/` to `/orcaui/`       | High     | Client consultation               |
| [2](#2-orcabusportal-runtime-shared-auth-and-config)                    | `@orcabus/portal-runtime` shared runtime | High     | Team agreement                    |
| [3](#3-serve-a-single-envjs-for-the-whole-portal)                       | Single `/env.js` for the whole portal    | Medium   | Item 2, app repo changes          |
| [4](#4-scope-cloudfront-invalidation-per-app)                           | Scope CloudFront invalidation per app    | Medium   | Nothing                           |
| [5](#5-set-cache-control-so-a-deploy-cannot-break-an-open-session)      | `Cache-Control` on `index.html`          | Medium   | Nothing                           |
| [6](#6-extract-a-reusable-portalapppipeline-construct)                  | Reusable `PortalAppPipeline` construct   | Medium   | Hub + OrcaHouse pipelines landing |
| [7](#7-decide-what-happens-to-v2-when-orcaui-v2-becomes-the-default-ui) | Retire the `/v2/` path                   | Medium   | Product decision                  |
| [8](#8-per-app-ssm-namespaces-and-fail-loud-parameter-reads)            | Per-app SSM namespaces, fail-loud reads  | Low      | Nothing                           |
| [9](#9-tsconfig-jest-globals)                                           | `tsconfig` jest globals                  | Low      | Nothing                           |

---

## 1. Move OrcaUI from `/` to `/orcaui/`

**Deferred because** existing users, bookmarks and links depend on `portal.umccr.org` loading
OrcaUI. This needs planning with clients, not just an infrastructure change.

**Cost of leaving it.** OrcaUI is privileged over the other apps in ways that will get more awkward
as apps are added:

- Every unmatched path falls through to OrcaUI, so `/typoo` renders OrcaUI's not-found page rather
  than a portal one.
- `/env.js`, `/favicon.ico`, `/robots.txt` and any future portal-level asset live in OrcaUI's
  bucket, so the portal's shared surface is owned by one app team.
- A landing page or app switcher at `/` cannot be added without shipping through OrcaUI.
- The cost of the move grows with each app added, because each one adds links to rewrite.

**Mitigation already in place.** `lib/portal/infra/apps.ts` models the root as just another app with
`pathPrefix: ''`, so the move is a registry change rather than a redesign.

**Interim guard rail.** Treat these paths as portal-owned and do not let OrcaUI define routes that
collide with them: `/env.js`, `/portal/*`, `/_health`. Worth adding to OrcaUI's own contributing
notes.

**What the move involves.**

1. Change `ORCAUI_APP.pathPrefix` from `''` to `'orcaui'`, and add a root app. The root can be a
   minimal portal shell (landing page plus app switcher) or a redirect-only app.
2. Preserve deep links. Every existing `portal.umccr.org/<route>` must keep working, so the root
   behaviour needs a catch-all that 301s `/<route>` to `/orcaui/<route>` for OrcaUI's known route
   prefixes. Without this, every bookmark breaks.
3. Update OrcaUI's router base path and asset base URL.
4. Keep the `orcaui.umccr.org` alias pointing at the same distribution, so that hostname is an
   alternative entry point during the transition.
5. Communicate the change and give a deprecation window before removing the catch-all.

**Note.** `ORCAUI_APP.id` must stay `orcaui` regardless. It maps to the deployed bucket construct ID
via `LEGACY_BUCKET_CONSTRUCT_IDS`; changing it deletes the live bucket.

## 2. `@orcabus/portal-runtime`: shared auth and config

**Deferred because** it needs agreement across app teams on the contract.

**Cost of leaving it.** Four independently built apps consume `window.config` and share one Cognito
session on one browser origin. Without a shared implementation they will drift: different token
storage keys, different refresh logic, different assumptions about which config keys exist. Drift
here shows up as users being logged out when moving between apps.

**What it involves.** A small package, published from one repo and consumed by all portal apps,
owning:

- the TypeScript type for `window.config`, so a missing or renamed key is a compile error;
- the token store and refresh logic, so the session is genuinely shared;
- a version marker on the config contract, so an app can detect an `env.js` older than it expects.

This is the single highest-value item for making four apps behave like one portal, and it unblocks
item 3.

## 3. Serve a single `/env.js` for the whole portal

**Deferred because** it needs a coordinated change in every app repo, and item 2 should define the
contract first.

**Current behaviour.** The config Lambda writes byte-identical config once per app, into each app's
own bucket: `env.js`, `v2/env.js`, `hub/env.js`, `orcahouse/env.js`. Each app loads its own copy
relative to its base path.

**Cost of leaving it.** N copies of the same file, N writes per deploy, and a window during which
one app has newer config than another.

**What it involves.** All apps share one origin, so they can all load the same absolute path:

```html
<script src="/env.js"></script>
```

One object, one write, and per-app config still possible via namespacing:

```js
window.config = {
  region: 'ap-southeast-2',
  apis: {/* shared */},
  auth: {/* shared */},
  apps: { hub: {}, orcahouse: {} },
};
```

Migration, so no app breaks mid-flight:

1. Lambda writes the shared `/env.js` **and** keeps writing the per-app copies.
2. Each app repo switches to the absolute path, at its own pace.
3. Once every app has moved, drop the per-app writes from `PORTAL_APP_TARGETS`.

**Trade-off.** `/env.js` lives in the root app's bucket, making it a shared dependency owned by
whichever app is at `/`. Interacts with item 1: after the OrcaUI move, `/env.js` should belong to
the portal shell instead.

## 4. Scope CloudFront invalidation per app

**Status: half done.** The Lambda accepts `{"app": "<id>"}` and the Hub and OrcaHouse pipelines pass
it, so a deploy now rewrites only its own app's `env.js`. **Invalidation is still `/*`.**

**Remaining because** it needs an `invalidationPath` per target and the OrcaUI pipelines to pass the
payload too. The current behaviour is correct, just wasteful.

**Current behaviour.** `env_config_and_cdn_refresh.py` invalidates `/*` on the shared distribution,
so any app's deploy evicts every other app's cached objects.

**Cost of leaving it.** Cache churn that grows with the number of apps. Not a correctness problem,
and cheap in dollars: an invalidation of `/*` counts as one path against the free tier.

**What is left.**

1. Add an `invalidationPath` to each entry in `PORTAL_APP_TARGETS`: `/<prefix>/*` for path-mounted
   apps, `/*` for the root app, which cannot be scoped more narrowly.
2. Invalidate the union of the selected targets' paths instead of the hardcoded `/*`.
3. Have the OrcaUI and OrcaUI v2 deploy steps pass `--payload '{"app":"<id>"}'` as the newer
   pipelines already do.

Keep the no-payload path invalidating `/*` for every app, so the manual runbook invocations in
[`docs/orcaui/README.md`](../orcaui/README.md) keep working unchanged.

**Note.** Deploys of the root app will still invalidate everything, by necessity.

## 5. Set `Cache-Control` so a deploy cannot break an open session

**Deferred because** it is a change to every deploy pipeline's sync step, best done alongside item 6.

**The hazard.** Deploys run `aws s3 sync . s3://<bucket>/<prefix>/ --delete`, which removes the
previous build's hashed asset files as soon as the new build lands. A browser holding a cached
`index.html` then requests chunk filenames that no longer exist, and the app fails until a hard
reload. Today the `/*` invalidation masks this by evicting the edge copy; it becomes sharper once
item 4 narrows invalidation, and it multiplies across apps.

**What it involves.** Two sync passes, so hashed assets cache forever and the shell never does:

```sh
aws s3 sync . s3://$BUCKET/$PREFIX/ --delete \
  --cache-control 'public,max-age=31536000,immutable' \
  --exclude 'index.html' --exclude 'env.js'

aws s3 sync . s3://$BUCKET/$PREFIX/ \
  --cache-control 'no-cache' \
  --exclude '*' --include 'index.html' --include 'env.js'
```

**Stronger option.** Drop `--delete` and expire old objects with an S3 lifecycle rule after about
seven days, so sessions in flight during a deploy keep working.

## 6. Extract a reusable `PortalAppPipeline` construct

**Status: the construct exists** at [`lib/portal/infra/app-pipeline.ts`](../../lib/portal/infra/app-pipeline.ts)
and Hub and OrcaHouse are built from it. **OrcaUI and OrcaUI v2 have not been migrated**, which is
the remaining work and was deliberately deferred so the construct's API was validated by two real
apps before touching production pipelines. It now has been.

**Cost of leaving it.** `lib/portal/orcaui/app-pipeline-stack.ts` and `v2-app-pipeline-stack.ts` are
largely duplicated, differing only in package manager, artifact directory, sync target and stage
gating. Each new app copies that again, and the copies drift.

**What is left: migrating OrcaUI and v2 onto it.** The construct currently assumes pnpm; OrcaUI uses
Yarn, so it needs a `packageManager` prop (or explicit `installCommands`) first. OrcaUI also runs an
OpenAPI type-check against staging, which the construct supports as `gammaPreDeployCommands`, and
puts its prod approval inside the gamma stage as a run-order step rather than in its own stage.

The existing pipelines have deployed CodeBuild and CodePipeline
physical names (`ReactBuildProject`, `ReactDeployProject<stage>`, `OrcaUIV2BuildProject`,
`OrcaUIAppCICDPipeline`, `OrcaUIV2AppCICDPipeline`) that must be reproduced exactly via
`namePrefix`. Verify with a template diff showing no changes beyond the intended ones. These stacks
are not self-mutating, so deploying them does not trigger a release.

## 7. Decide what happens to `/v2/` when OrcaUI v2 becomes the default UI

**Deferred because** it is a product decision, not an infrastructure one.

**The issue.** `v2` is a version, not an app name. Once v2 is the UI everyone uses, `/v2/` is a
permanent oddity and `/` still serves the old app.

**Options.**

- Point the root behaviour at the v2 bucket and turn `/v2/` into a redirect to `/`. Simplest, but
  ties into item 1: if OrcaUI moves to `/orcaui/`, v2 should probably become `/orcaui/` and v1 be
  retired outright.
- Give both apps names (`/orcaui/` and, say, `/orcaui-next/`) and let the portal shell at `/` decide
  which one to send people to. More flexible, needs item 1 first.

Either way it is a registry change plus a redirect rule, so the cost is in the decision and the
communication rather than the code.

## 8. Per-app SSM namespaces and fail-loud parameter reads

**Deferred because** Hub and OrcaHouse are expected to reuse OrcaUI's config payload initially.

**Current behaviour.** The config Lambda's role allows `ssm:Get*` on `/orcaui/*` and
`/data_portal/*` only, and `get_ssm_parameter` catches every exception, logs it, and returns `None`.
The key is then dropped from `env.js`.

**Cost of leaving it.** A missing IAM permission or a typo'd parameter name looks exactly like a
missing config value: the app loads with a silently absent key. Also, one shared Lambda means every
app's config Lambda can read every other app's parameters.

**What it involves.**

- Add each app's namespace to the role's resource list as apps start needing their own parameters.
- Distinguish required from optional parameters, and fail the invocation for a missing required one,
  so the deploy goes red instead of shipping a broken config.
- If genuine isolation is wanted, give each app its own config Lambda scoped to its own namespace.
  That is also the right answer if item 3's shared payload turns out not to suit an app.

**Related.** All portal apps share one browser origin, so they share cookies, `localStorage` and the
Cognito session. That is what makes SSO across the portal work, and it means the four apps are one
trust boundary: an XSS in any of them can read the others' tokens. Accepted deliberately; item 2 is
the mitigation, by keeping token handling in one reviewed place.

## 9. `tsconfig` jest globals

`tsconfig.json` sets `"types": ["node"]`, which drops the `@types/jest` globals. Current tests import
from `@jest/globals` explicitly so this passes, but a future test using a bare `describe` fails
typecheck with a confusing message.

Pick one: set `"types": ["node", "jest"]`, or keep the tightening and remove the now-unused
`@types/jest` from `devDependencies`.

## 10. Close the gamma gap for Hub and OrcaHouse

**Deferred because** the team chose beta and prod only, to ship sooner.

**Cost of leaving it.** Changes to these apps go from beta straight to prod with only a manual
approval in between, and a `lib/portal/infra/**` change that affects them is first exercised against them
in production. `GAMMA_GAP_APPS` in [`apps.ts`](../../lib/portal/infra/apps.ts) names them, and a test
asserts the list, so the gap cannot widen silently.

**What it involves.** Add the gamma bucket to each app's `bucketName`. The hosting stack and the
pipeline both pick the stage up automatically: a `DeployToGamma` stage appears between beta and the
prod approval. No code change.

---

## Explicitly not planned

- **Module federation or a single-spa style shared runtime shell.** Apps are separate SPAs with hard
  navigation between them. That is simpler to build, deploy and reason about, and independent
  deployability is the property we actually want. Revisit only if navigating between apps needs to
  preserve in-memory state.
- **A distribution or subdomain per app.** Path-based routing on one distribution means no extra
  certificates, no extra DNS records and a shared session. The quotas are not a constraint:
  CloudFront allows 75 cache behaviours per distribution and 100 functions per account, both
  raisable on request.
- **Renaming the deployed `OrcaUI*` identities** (`OrcaUIInfrastructurePipeline`,
  `OrcaUIInfrastructureStack`, `OrcaUIAssetCloudFrontBucket`, `CodeBuildEnvConfigLambda*`). The
  names no longer describe resources shared by every portal app, but they are resource identities
  and the buckets are `RemovalPolicy.DESTROY` with `autoDeleteObjects`. Renaming deletes live data.
- **Changing the `<app>-cloudfront-<account-id>` bucket naming convention.** Consistent with the
  existing buckets, and the account-ID suffix makes global collisions a non-issue.
