# Frontend Infrastructure Pipelines

AWS CDK app for UMCCR frontend hosting infrastructure (S3, CloudFront, Route 53, runtime config) and the CI/CD
pipelines that build and deploy each frontend.

Pipelines run in the toolchain account (`383856791668`) and deploy to beta (`843407916570`), gamma (`455634345446`)
and prod (`472057503814`) in `ap-southeast-2`.

## Frontends

Every frontend is served from the same hostname, `portal.<stage>.umccr.org`, on its own URL path prefix, backed by
its own S3 bucket behind one shared CloudFront distribution. The registry of apps and their prefixes is
[`lib/portal/apps.ts`](lib/portal/apps.ts).

| Frontend  | URL path      | Repo                 | App pipeline                       | Stages            |
| --------- | ------------- | -------------------- | ---------------------------------- | ----------------- |
| OrcaUI    | `/`           | `OrcaBus/orca-ui`    | [`lib/orcaui/`](lib/orcaui/)       | beta, gamma, prod |
| OrcaUI v2 | `/v2/`        | `OrcaBus/orca-ui-v2` | [`lib/orcaui/`](lib/orcaui/)       | beta, gamma, prod |
| Hub       | `/hub/`       | `umccr/hub`          | [`lib/hub/`](lib/hub/)             | beta, prod        |
| OrcaHouse | `/orcahouse/` | `umccr/orcahouse-ui` | [`lib/orcahouse/`](lib/orcahouse/) | beta, prod        |

Docs:

- [`docs/portal/`](docs/portal/README.md) — how routing, hosting and runtime config work.
- [`docs/portal/onboarding-an-app.md`](docs/portal/onboarding-an-app.md) — what an app repository must
  do to be hosted here. Base path, artifact directory, routing mode, `env.js`.
- [`docs/portal/future-improvements.md`](docs/portal/future-improvements.md) — deferred work and open
  decisions.
- [`docs/orcaui/`](docs/orcaui/README.md) — the OrcaUI pipelines. OrcaUI was migrated from
  `OrcaBus/orca-ui` `deploy/`, see
  [`docs/migration-from-orca-ui.md`](docs/migration-from-orca-ui.md).

## Repository layout

```text
.
├── bin/app.ts              # CDK entrypoint; registers every stack
├── lib/
│   ├── common/             # Org-wide constants (accounts, region, stages)
│   ├── portal/             # Shared hosting infra for portal.<stage>.umccr.org:
│   │                       #   apps.ts (the app registry: which app is on which path),
│   │                       #   buckets, CloudFront, Route 53, env config Lambda,
│   │                       #   SPA rewrite function template, app-pipeline.ts
│   ├── orcaui/             # One folder per frontend, app CI/CD pipeline stacks only
│   ├── hub/
│   └── orcahouse/
├── test/
│   ├── common/             # Shared test helpers (cdk-nag)
│   └── portal/             # Tests mirror lib/
└── docs/
    ├── portal/             # Hosting model, routing, runtime config, future improvements
    └── orcaui/             # Per-frontend runbooks and design notes
```

The split matters: **`lib/portal/` owns hosting, `lib/<frontend>/` owns building and shipping.** A new frontend adds
an entry to `lib/portal/apps.ts` and a pipeline stack under `lib/<frontend>/`; it does not get its own CloudFront
distribution or DNS record.

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

## Adding a new frontend

1. Add a `PortalApp` entry to [`lib/portal/apps.ts`](lib/portal/apps.ts) with its `pathPrefix` and per-stage bucket
   names. Leave a stage's bucket `undefined` to skip it, which is how a new app rolls out beta first.
   The hosting stack derives everything else from that entry: the S3 bucket, the `/<prefix>/*` CloudFront
   behaviour, the SPA rewrite allowlist and the `env.js` target. There is no second place to register a prefix.
2. Create `lib/<frontend>/app-pipeline-stack.ts` using the shared
   [`PortalAppPipeline`](lib/portal/app-pipeline.ts) construct, which handles source, build, per-stage
   deploy, caching and the env config Lambda invoke. [`lib/hub/`](lib/hub/) is a minimal example.
   The app repo also has requirements: see
   [`docs/portal/onboarding-an-app.md`](docs/portal/onboarding-an-app.md).
3. Register the pipeline stack in `bin/app.ts`, tagged with `umccr-org:Stack` and `umccr-org:Product`.
4. Pick names that are unique across the whole account. CloudFormation stack IDs, CodePipeline names, CodeBuild
   project names, Lambda function names and S3 bucket names all share one namespace with OrcaUI's existing resources.
   Prefix them with the frontend name.
5. Add tests under `test/<frontend>/` (including cdk-nag checks) and docs under `docs/<frontend>/`.
6. Promote to gamma and prod by adding those stages to `bucketName`.

Step 1 changes `lib/portal/**` and so triggers the shared infrastructure pipeline
(`PORTAL_INFRASTRUCTURE_FILE_PATHS` in
[`lib/portal/infrastructure-deployment-stack.ts`](lib/portal/infrastructure-deployment-stack.ts)), which redeploys
hosting for **every** frontend. Steps 2 and 3 do not: app pipeline stacks are deployed manually and are not
self-mutating.

Before merging a `lib/portal/**` change, confirm the blast radius with a template diff: adding an app should add
resources and rename or remove none. See
[`docs/portal/README.md`](docs/portal/README.md#verifying-a-change).

## Conventions

- **Never rename deployed stack or construct IDs** without a migration plan. CDK treats a rename as delete + create,
  and several resources here use fixed physical names and `RemovalPolicy.DESTROY`.
- Keep changes to shared files (`bin/`, `lib/common/`, `lib/portal/`, `package.json`, `pnpm-lock.yaml`, `cdk.json`)
  small and reviewed. They start the shared infrastructure pipeline, which redeploys hosting for every frontend.
- Some deployed names still say `OrcaUI` even though the resources are now shared by every portal app
  (`OrcaUIInfrastructurePipeline`, `OrcaUIInfrastructureStack`, `OrcaUIAssetCloudFrontBucket`). That mismatch is
  intentional: the names are resource identities, and renaming them would replace live resources.
- Check a PR's effect with `pnpm cdk diff` before merging to `main`.
