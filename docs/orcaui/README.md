# OrcaUI Deployment

AWS CDK stacks for OrcaUI hosting infrastructure and CI/CD pipelines. Shared hosting lives in [`lib/portal/infra/`](../../lib/portal/infra/); the OrcaUI app pipelines are in [`lib/portal/orcaui/`](../../lib/portal/orcaui/).

> Migrated from `OrcaBus/orca-ui` `deploy/`. See [`docs/migration-from-orca-ui.md`](../migration-from-orca-ui.md) for the cutover plan.

## Overview

The CDK app is composed in [`bin/app.ts`](../../bin/app.ts) and creates these OrcaUI pipeline stacks in the toolchain account. Hub and OrcaHouse have their own, documented in [`docs/portal/`](../portal/README.md):

| CDK stack                      | CodePipeline name              | Source repository                                | Trigger                              | Purpose                                                                                                                            |
| ------------------------------ | ------------------------------ | ------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `OrcaUIInfrastructurePipeline` | `OrcaBus-OrcaUIInfrastructure` | `umccr/frontend-infrastructure-pipelines` `main` | shared files + `lib/portal/infra/**` | Synthesizes CDK and deploys the shared `InfrastructureStack` to beta, gamma, and prod. Despite the name it hosts every portal app. |
| `OrcaUIAppPipeline`            | `OrcaUIAppCICDPipeline`        | `OrcaBus/orca-ui` `main`                         | excludes `deploy/**`                 | Builds and deploys the current UI app to the primary CloudFront bucket.                                                            |
| `OrcaUIV2AppPipeline`          | `OrcaUIV2AppCICDPipeline`      | `OrcaBus/orca-ui-v2` `main`                      | excludes `deploy/**`                 | Builds and deploys UI v2 to the configured v2 CloudFront bucket under the `v2/` prefix.                                            |

`InfrastructureStack` is **shared by every portal app**, not just OrcaUI. It owns, in each target
account, one S3 bucket per hosted app, the shared CloudFront distribution and Route 53 aliases, the
SPA routing function, and the env config Lambda. See [`docs/portal/README.md`](../portal/README.md)
for how it is driven by the app registry.

## Deployment Strategy

Infrastructure changes flow through `OrcaUIInfrastructurePipeline`:

1. A push to this repository on `main` that touches `lib/portal/infra/**` or shared files (`bin/**`, `lib/common/**`, `package.json`, `pnpm-lock.yaml`, `cdk.json`, ...) triggers the infrastructure pipeline. The exact list is `PORTAL_INFRASTRUCTURE_FILE_PATHS` in [`infrastructure-deployment-stack.ts`](../../lib/portal/infra/infrastructure-deployment-stack.ts). Changes to the app pipeline stacks under `lib/portal/orcaui/**` do not trigger it; those pipelines are deployed manually.
2. The pipeline installs dependencies at the repository root, runs the tests, and runs `pnpm cdk synth`.
3. CDK self-mutation updates the pipeline when needed.
4. `InfrastructureStack` is deployed to beta, gamma, then prod. Gamma has a manual approval before promotion to prod.

Application code deploys independently:

- `OrcaUIAppPipeline` builds `OrcaBus/orca-ui`, syncs the `dist/` artifact to the primary bucket root, then invokes the env config Lambda.
- `OrcaUIV2AppPipeline` builds `OrcaBus/orca-ui-v2`, syncs the `build/` artifact to `s3://<v2-bucket>/v2/`, then invokes the same env config Lambda.

UI v2 is enabled per stage by `ORCAUI_V2_APP.bucketName` in [`lib/portal/infra/apps.ts`](../../lib/portal/infra/apps.ts). See [`ui-v2-deployment-strategy.md`](./ui-v2-deployment-strategy.md) for why v2 is hosted at `/v2/`.

## Env Config Lambda

The env config Lambda is defined in [`lib/portal/infra/lambda/env_config_and_cdn_refresh.py`](../../lib/portal/infra/lambda/env_config_and_cdn_refresh.py).

The app deploy CodeBuild projects invoke this Lambda after syncing assets to S3. The Lambda writes
`<prefix>/env.js` into each hosted app's bucket, reading the target list from the
`PORTAL_APP_TARGETS` environment variable, then creates a CloudFront invalidation for the shared
distribution. Full details, including how to target a single app, are in
[`docs/portal/README.md`](../portal/README.md#runtime-config).

Invoke manually without a payload to rewrite every app's `env.js`:

```sh
aws lambda invoke \
  --function-name CodeBuildEnvConfigLambdaBeta \
  response.json
```

Invoke manually with a payload to update API versions:

```sh
aws lambda invoke \
  --function-name CodeBuildEnvConfigLambdaBeta \
  --cli-binary-format raw-in-base64-out \
  --payload '{"metadata_api_version": "v2"}' \
  response.json
```

Update multiple API versions:

```sh
aws lambda invoke \
  --function-name CodeBuildEnvConfigLambdaBeta \
  --cli-binary-format raw-in-base64-out \
  --payload '{
    "metadata_api_version": "v2",
    "workflow_api_version": "v2",
    "sequence_run_api_version": "v1",
    "file_api_version": "v2"
  }' \
  response.json
```

Invoke with a specific AWS profile:

```sh
aws lambda invoke \
  --profile your-profile-name \
  --function-name CodeBuildEnvConfigLambdaBeta \
  --cli-binary-format raw-in-base64-out \
  --payload '{"metadata_api_version": "v2"}' \
  response.json
```

Use the stage-specific function name when targeting another environment:

- `CodeBuildEnvConfigLambdaBeta`
- `CodeBuildEnvConfigLambdaGamma`
- `CodeBuildEnvConfigLambdaProd`

## Development

Run all commands from the repository root.

Install dependencies:

```sh
corepack enable
pnpm install --frozen-lockfile
```

Run tests:

```sh
pnpm test
```

List CDK stacks:

```sh
pnpm cdk ls
```

Example stack output:

```sh
OrcaUIInfrastructurePipeline
OrcaUIAppPipeline
OrcaUIV2AppPipeline
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack (OrcaBusBeta-OrcaUIInfrastructureStack)
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusGamma/OrcaUIInfrastructureStack (OrcaBusGamma-OrcaUIInfrastructureStack)
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusProd/OrcaUIInfrastructureStack (OrcaBusProd-OrcaUIInfrastructureStack)
```

Deploy the top-level pipeline stacks:

```sh
pnpm cdk deploy -e OrcaUIInfrastructurePipeline
pnpm cdk deploy -e OrcaUIAppPipeline
pnpm cdk deploy -e OrcaUIV2AppPipeline
```

Work directly with the beta infrastructure stack:

```sh
pnpm cdk synth -e OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack
pnpm cdk diff -e OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack
pnpm cdk deploy -e OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack
```

Direct application stack deploys require AWS credentials for the target account and the usual CDK bootstrap roles.

## Migration Note

The CDK app now uses three top-level stack IDs instead of the older combined `OrcaUIPipeline` stack, and the app CI/CD stacks are named `OrcaUIAppPipeline` and `OrcaUIV2AppPipeline`. If older pipeline stacks already exist in AWS, do not deploy the new stacks blindly: named resources such as CodePipeline and CodeBuild projects may still be owned by an old stack. Plan the migration so ownership of existing resources is handled intentionally.
