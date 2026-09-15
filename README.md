# Frontend Infrastructure Pipelines

AWS CDK app for UMCCR frontend hosting infrastructure (S3, CloudFront, Route 53, runtime config) and the CI/CD
pipelines that build and deploy each frontend.

Pipelines run in the toolchain account (`383856791668`) and deploy to beta (`843407916570`), gamma (`455634345446`)
and prod (`472057503814`) in `ap-southeast-2`.

## Frontends

| Frontend | App repositories                          | Source                          | Docs                                       |
| -------- | ----------------------------------------- | ------------------------------- | ------------------------------------------ |
| OrcaUI   | `OrcaBus/orca-ui`, `OrcaBus/orca-ui-v2`   | [`lib/orcaui/`](lib/orcaui/)    | [`docs/orcaui/`](docs/orcaui/README.md)    |

OrcaUI was migrated from `OrcaBus/orca-ui` `deploy/`. See
[`docs/migration-from-orca-ui.md`](docs/migration-from-orca-ui.md).

## Repository layout

```text
.
├── bin/app.ts              # CDK entrypoint; registers every frontend's stacks
├── lib/
│   ├── common/             # Org-wide constants shared by all frontends (accounts, region, stages)
│   └── orcaui/             # One folder per frontend: config, stacks, Lambda/CloudFront function sources
├── test/
│   └── orcaui/             # Tests mirror lib/
└── docs/
    └── orcaui/             # Per-frontend runbooks and design notes
```

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

1. Create `lib/<frontend>/` with its own `config.ts`, stacks and any Lambda sources. Import shared values from
   `lib/common/config.ts` rather than duplicating account IDs.
2. Register its stacks in `bin/app.ts` under a new section, tagged with `umccr-org:Stack` and `umccr-org:Product`.
3. Pick names that are unique across the whole account. CloudFormation stack IDs, CodePipeline names, CodeBuild
   project names, Lambda function names and S3 bucket names all share one namespace with OrcaUI's existing resources.
   Prefix them with the frontend name.
4. If it uses a self-mutating infrastructure pipeline, set its trigger file paths to the shared files plus its own
   `lib/<frontend>/**`, so changes to other frontends don't start it. See `ORCAUI_INFRASTRUCTURE_FILE_PATHS` in
   [`lib/orcaui/infrastructure-deployment-stack.ts`](lib/orcaui/infrastructure-deployment-stack.ts).
5. Add tests under `test/<frontend>/` (including cdk-nag checks) and docs under `docs/<frontend>/`.

## Conventions

- **Never rename deployed stack or construct IDs** without a migration plan. CDK treats a rename as delete + create,
  and several resources here use fixed physical names and `RemovalPolicy.DESTROY`.
- Keep changes to shared files (`bin/`, `lib/common/`, `package.json`, `pnpm-lock.yaml`, `cdk.json`) small and reviewed.
  They start every frontend's infrastructure pipeline.
- Check a PR's effect with `pnpm cdk diff` before merging to `main`.
