# Frontend Infrastructure Pipelines

AWS CDK app for UMCCR frontend hosting infrastructure (S3, CloudFront, Route 53, runtime config) and the CI/CD
pipelines that build and deploy each frontend.

Pipelines run in the toolchain account (`383856791668`) and deploy to beta (`843407916570`), gamma (`455634345446`)
and prod (`472057503814`) in `ap-southeast-2`.

## Frontends

Every frontend is served from the same hostname, `portal.<stage>.umccr.org`, on its own URL path prefix, backed by
its own S3 bucket behind one shared CloudFront distribution. The registry of apps and their prefixes is
[`lib/portal/infra/apps.ts`](lib/portal/infra/apps.ts); shared hosting lives in
[`lib/portal/infra/`](lib/portal/infra/) and each app's CI/CD pipeline in `lib/portal/<app>/`.

| Frontend  | URL path      | Repo                 | App pipeline                                     | Stages            |
| --------- | ------------- | -------------------- | ------------------------------------------------ | ----------------- |
| OrcaUI    | `/`           | `OrcaBus/orca-ui`    | [`lib/portal/orcaui/`](lib/portal/orcaui/)       | beta, gamma, prod |
| OrcaUI v2 | `/v2/`        | `OrcaBus/orca-ui-v2` | [`lib/portal/orcaui/`](lib/portal/orcaui/)       | beta, gamma, prod |
| Hub       | `/hub/`       | `umccr/hub`          | [`lib/portal/hub/`](lib/portal/hub/)             | beta, prod        |
| OrcaHouse | `/orcahouse/` | `umccr/orcahouse-ui` | [`lib/portal/orcahouse/`](lib/portal/orcahouse/) | beta, prod        |

## Development

Requires Node.js 22 (matching CodeBuild) and Corepack.

```sh
corepack enable
pnpm install --frozen-lockfile

pnpm test            # unit + cdk-nag tests
pnpm cdk ls          # list stacks
pnpm cdk synth       # synthesize all stacks
pnpm cdk diff <stack-id>
```

Deploying requires AWS credentials for the target account. See each frontend's docs for which stacks deploy
manually and which ones deploy through a self-mutating pipeline.

## Documentation

- [Repository layout](docs/repository-layout.md) — where everything lives and why the infra/app split matters.
- [Deploying](docs/deploying.md) — the infra vs app pipeline model and how a change reaches prod.
- [Adding a new frontend](docs/adding-a-new-frontend.md) — a portal app (same domain) vs a new domain.
- [`docs/portal/`](docs/portal/README.md) — how routing, hosting and runtime config work.
  - [`onboarding-an-app.md`](docs/portal/onboarding-an-app.md) — what an app repository must do to be hosted here.
  - [`future-improvements.md`](docs/portal/future-improvements.md) — deferred work and open decisions.
- Per-frontend notes: [`docs/orcaui/`](docs/orcaui/README.md), [`docs/hub/`](docs/hub/README.md),
  [`docs/orcahouse-ui/`](docs/orcahouse-ui/README.md), [`docs/cognito-aai/`](docs/cognito-aai/README.md).
- OrcaUI was migrated from `OrcaBus/orca-ui` `deploy/`; see
  [`docs/migration-from-orca-ui.md`](docs/migration-from-orca-ui.md).

## Related repositories

- [`OrcaBus/orca-ui`](https://github.com/OrcaBus/orca-ui), [`OrcaBus/orca-ui-v2`](https://github.com/OrcaBus/orca-ui-v2) — OrcaUI apps.
- [`umccr/hub`](https://github.com/umccr/hub), [`umccr/orcahouse-ui`](https://github.com/umccr/orcahouse-ui) — Hub and OrcaHouse apps.
- [`umccr/infrastructure`](https://github.com/umccr/infrastructure) — `cognito_aai` stack owns the per-app Cognito callback URLs.

## Conventions

- **Never rename deployed stack or construct IDs** without a migration plan. CDK treats a rename as delete + create,
  and several resources here use fixed physical names and `RemovalPolicy.DESTROY`.
- Keep changes to shared files (`bin/`, `lib/common/`, `lib/portal/infra/`, `package.json`, `pnpm-lock.yaml`,
  `cdk.json`) small and reviewed. They start the shared infrastructure pipeline, which redeploys hosting for every
  frontend.
- Some deployed names still say `OrcaUI` even though the resources are now shared by every portal app
  (`OrcaUIInfrastructurePipeline`, `OrcaUIInfrastructureStack`, `OrcaUIAssetCloudFrontBucket`). That mismatch is
  intentional: the names are resource identities, and renaming them would replace live resources.
- Check a PR's effect with `pnpm cdk diff` before merging to `main`.
