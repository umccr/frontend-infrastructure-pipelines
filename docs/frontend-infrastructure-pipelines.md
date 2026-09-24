# frontend-infrastructure-pipelines — context

A CDK app for UMCCR frontend hosting infrastructure and the CI/CD pipelines that build and deploy each
frontend. This is a working context file for the portal model; per-frontend detail lives in the sibling
docs folders (`docs/hub/`, `docs/orcahouse-ui/`, `docs/cognito-aai/`, `docs/orcaui/`).

## Accounts and regions

Pipelines run in the toolchain account (`383856791668`) and deploy to beta (`843407916570`), gamma
(`455634345446`) and prod (`472057503814`), all in `ap-southeast-2`.

## The portal model

The portal is one shared hosting platform, driven by an app registry, serving several independently
built frontends on one domain. Each app lives on its own URL path prefix behind a single CloudFront
distribution, each from its own S3 bucket:

| App       | Path          | Repo                 | Stages                |
| --------- | ------------- | -------------------- | --------------------- |
| OrcaUI    | `/`           | `OrcaBus/orca-ui`    | beta, gamma, prod     |
| OrcaUI v2 | `/v2/`        | `OrcaBus/orca-ui-v2` | per config            |
| Hub       | `/hub/`       | `umccr/hub`          | beta, prod (no gamma) |
| OrcaHouse | `/orcahouse/` | `umccr/orcahouse-ui` | beta, prod (no gamma) |

Adding a frontend is a registry entry plus a small pipeline stack — not a new distribution or DNS
record. Hub and OrcaHouse intentionally have no gamma stage (tracked as a gamma gap).

## Key design points

- **`lib/portal/apps.ts` is the single source of truth.** Each app declares `id`, `pathPrefix`, `repo`,
  `clientRouting` mode and per-stage bucket names. The hosting stack derives the bucket, the
  `/<prefix>/*` CloudFront behaviour, the SPA-rewrite entry and the `env.js` target from it, so a
  prefix is registered in exactly one place and a behaviour cannot drift from its rewrite rule.
- **Two client-routing modes.** `spa` (OrcaUI, v2, Hub) rewrites every route to one `index.html`;
  `static-export` (OrcaHouse's Next.js export) rewrites `/orcahouse/a/b` to `/orcahouse/a/b/index.html`.
  The CloudFront Function's route table is generated at synth time from the registry (CloudFront
  Functions take no env vars, so it is baked in). Synth throws if the template declaration can't be
  found, so a reformat can't silently ship an empty table.
- **Reusable `PortalAppPipeline` construct.** Source → build → per-stage deploy → prod approval. Stages
  are derived from `bucketName`: a stage with no bucket gets no deploy stage, which is how beta-first
  rollout works. Baked in per app: pnpm pinned via `corepack install` (reads each repo's
  `packageManager`) on Node 24; a two-pass S3 sync (hashed assets `immutable` for a year, `index.html`
  and friends `no-cache`) so a `--delete` deploy can't break an already-open tab; `*.map` never
  uploaded; and `env.js` excluded from both sync passes (the config Lambda owns it) with the deploy
  invoking the Lambda as `{"app":"<id>"}` so it rewrites only its own config.
- **Config Lambda generalised.** `env.js` fan-out is driven by a `PORTAL_APP_TARGETS` list rather than
  a single `V2_BUCKET_NAME`, so a new app needs no Lambda change.

## Deployed-identity preservation

Physical names still say `OrcaUI` (`OrcaUIInfrastructurePipeline`, `OrcaUIInfrastructureStack`,
`OrcaUIAssetCloudFrontBucket`, `CodeBuildEnvConfigLambda*`) because they are deployed resource
identities. The buckets are `RemovalPolicy.DESTROY` with `autoDeleteObjects`, so a rename would delete
live data. `LEGACY_BUCKET_CONSTRUCT_IDS` pins the existing bucket construct IDs and a test asserts they
still synthesize. Never rename a deployed stack or construct ID without a migration plan.

## Repository layout

```text
.
├── bin/app.ts              # CDK entrypoint; registers every frontend's stacks
├── lib/
│   ├── common/             # Org-wide constants (accounts, region, stages)
│   ├── portal/             # Shared hosting: registry (apps.ts), PortalAppPipeline, infra stack, config Lambda
│   ├── hub/                # Hub app pipeline stack
│   ├── orcahouse/          # OrcaHouse app pipeline stack
│   └── orcaui/             # OrcaUI + v2 app pipelines
├── test/                   # Tests mirror lib/
└── docs/                   # Per-frontend runbooks and design notes
```

## Verification and deploy

- `pnpm test` runs unit + cdk-nag tests, including behavioural tests that execute the generated
  CloudFront function for both routing modes and pipeline tests asserting the two-pass sync globs stay
  consistent (a file excluded from pass one must be re-added by pass two, or it is never uploaded).
- The template diff for existing OrcaUI/v2 resources is additive: no logical ID removed or renamed;
  new Hub/OrcaHouse buckets and behaviours plus the generalised Lambda and rewrite-function bodies are
  the only changes. Reproduce with `pnpm cdk synth` before/after and `diff -r` (ignoring
  `*.metadata.json`, `tree.json`, `*.dot`).
- `HubAppPipeline` and `OrcaHouseAppPipeline` are deployed manually (`pnpm cdk deploy …`) and are not
  self-mutating. Their `/hub/*` and `/orcahouse/*` origins are empty until their app pipelines run.

## Cross-repo dependencies

- Cognito callback URLs for each path prefix live in `umccr/infrastructure` `cognito_aai` — apply an
  environment's URLs before that environment's app deploys, or sign-in is rejected with
  `redirect_mismatch`. See `docs/cognito-aai/`.
- Portal-fit changes in the apps themselves: `umccr/hub` (see `docs/hub/`) and `umccr/orcahouse-ui`
  (see `docs/orcahouse-ui/`).

## Known follow-ups

Migrating the OrcaUI/v2 pipelines onto `PortalAppPipeline`, scoping cache invalidation per app, a shared
`@orcabus/portal-runtime`, the eventual OrcaUI `/` → `/orcaui/` move, and closing the gamma gap for Hub
and OrcaHouse.
