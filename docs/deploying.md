# Deploying

How changes in this repository reach beta, gamma and prod. There are **two kinds of pipeline** with
different mechanics, and knowing which one you are touching is the whole game.

Everything runs in the toolchain account (`383856791668`) and deploys cross-account into beta
(`843407916570`), gamma (`455634345446`) and prod (`472057503814`), all in `ap-southeast-2`.

## The two pipelines

|               | Infrastructure pipeline                                                                                         | App pipelines                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Stack         | `OrcaUIInfrastructurePipeline`                                                                                  | `OrcaUIAppPipeline`, `OrcaUIV2AppPipeline`, `HubAppPipeline`, `OrcaHouseAppPipeline`                                 |
| Deploys       | the shared `InfrastructureStack` (buckets, CloudFront, DNS, env config Lambda) to every stage                   | one frontend's built assets to its bucket                                                                            |
| Source        | `umccr/frontend-infrastructure-pipelines` (this repo)                                                           | the app repo (`OrcaBus/orca-ui`, `umccr/hub`, ...)                                                                   |
| Self-mutating | **yes** — a pipeline run redeploys the pipeline itself, then the stacks                                         | **no** — `cdk deploy` only updates the pipeline definition                                                           |
| Triggered by  | a push to `main` touching `lib/portal/infra/**` or shared files                                                 | a push to the **app repo's** `main`                                                                                  |
| Defined in    | [`lib/portal/infra/infrastructure-deployment-stack.ts`](../lib/portal/infra/infrastructure-deployment-stack.ts) | `lib/portal/<app>/app-pipeline-stack.ts`, from the shared [`PortalAppPipeline`](../lib/portal/infra/app-pipeline.ts) |

The mental model: **the infrastructure pipeline owns the hosting; the app pipelines own the
contents.** Buckets, the CloudFront distribution and the config Lambda come from the first. What lands
inside each bucket comes from the second.

## `pnpm cdk ls`

```text
OrcaUIInfrastructurePipeline
OrcaUIAppPipeline
OrcaUIV2AppPipeline
HubAppPipeline
OrcaHouseAppPipeline
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack (OrcaBusBeta-OrcaUIInfrastructureStack)
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusGamma/OrcaUIInfrastructureStack (OrcaBusGamma-OrcaUIInfrastructureStack)
OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusProd/OrcaUIInfrastructureStack (OrcaBusProd-OrcaUIInfrastructureStack)
```

The top five are the pipeline stacks you deploy from your machine. The three nested
`.../OrcaBus<Stage>/OrcaUIInfrastructureStack` entries are the per-stage hosting stacks that the
infrastructure pipeline deploys **for you** — you normally never deploy those directly, they are
listed because CDK Pipelines models them as stages of the pipeline. (`cdk synth`/`diff` against a
nested ID is fine for inspection; see [Inspecting a single stage](#inspecting-a-single-stage).)

## Infrastructure pipeline: how a change flows

1. You merge a change under `lib/portal/infra/**` (or a shared file: `bin/**`, `lib/common/**`,
   `package.json`, `pnpm-lock.yaml`, `cdk.json`) to `main`. Docs-only changes are excluded and do not
   trigger a run. The exact include/exclude lists are `PORTAL_INFRASTRUCTURE_FILE_PATHS` and
   `INFRASTRUCTURE_EXCLUDED_FILE_PATHS`.
2. The pipeline's Source stage pulls the commit; the Build stage installs, runs `pnpm run test` and
   `pnpm cdk synth`.
3. **Self-mutation**: if the pipeline definition itself changed, the pipeline updates itself first,
   then re-runs.
4. It deploys `OrcaUIInfrastructureStack` to **beta → gamma → prod**, with a manual approval before
   prod.

Because one run touches all three stages, a `lib/portal/infra/**` change has a wide blast radius:
**it redeploys hosting for every frontend.** Verify before merging — see
[Verifying an infrastructure change](#verifying-an-infrastructure-change).

### Deploying the infrastructure pipeline manually

You only do this to change the **pipeline itself** (its source, triggers, build commands), or for the
one-time bootstrap. Normal hosting changes go through `main` and self-mutation, not a manual deploy.

```sh
pnpm cdk diff OrcaUIInfrastructurePipeline     # review the pipeline definition change
pnpm cdk deploy OrcaUIInfrastructurePipeline   # update the pipeline, then release a run
```

After deploying, release a pipeline run (console or `aws codepipeline start-pipeline-execution`) and
confirm it is green through to prod.

## App pipelines: how a change flows

1. You merge a change to the **app repo's** `main` (e.g. `umccr/hub`). The app pipeline's Source stage
   picks it up. A trigger filter can exclude paths (OrcaUI/v2 exclude the legacy `deploy/**`).
2. Build stage: `corepack enable && corepack install` (resolving the app's own pinned pnpm), then the
   app's build command, capturing `artifactBaseDirectory` as the artifact.
3. Deploy stage, per configured stage in promotion order (beta → gamma → prod), prod behind a manual
   approval:
   - Two-pass S3 sync into `s3://<bucket>/<prefix>/`. Hashed assets cache for a year; `index.html` and
     other stable names never cache. `--delete` prunes the previous build. `env.js` and `*.map` are
     excluded.
   - Invoke the env config Lambda with `{"app":"<id>"}` so it rewrites only this app's `env.js` and
     invalidates CloudFront. The build fails if the Lambda reports an error.

A stage with no bucket in the app's registry entry gets **no deploy stage**, which is how a new app
rolls out beta-first.

### Deploying an app pipeline manually — worked example (Hub)

App pipeline stacks are **not** self-mutating, so `cdk deploy` updates the CloudFormation resources
(the pipeline, its CodeBuild projects and IAM roles) **without** starting a release. A release only
happens on a push to the app repo's `main` or a manual "Release change" in the console.

```sh
# 1. Review what changes in the pipeline definition (not the app's contents).
pnpm cdk diff HubAppPipeline

# 2. Apply it. This does NOT deploy Hub itself; it updates the pipeline.
pnpm cdk deploy HubAppPipeline

# 3. To actually ship Hub, push to umccr/hub main, or release the pipeline:
aws codepipeline start-pipeline-execution --name HubAppCICDPipeline
```

The same pattern applies to `OrcaUIAppPipeline`, `OrcaUIV2AppPipeline` and `OrcaHouseAppPipeline`.
Deploy several at once:

```sh
pnpm cdk deploy HubAppPipeline OrcaHouseAppPipeline
```

## Runtime config (`env.js`)

Both kinds of deploy end up touching `env.js`: an app deploy invokes the env config Lambda for its own
app, and you can invoke it directly to rewrite config without a code change. Full reference, including
per-app targeting and API-version overrides, is in [`docs/portal/README.md`](portal/README.md#runtime-config).

```sh
# Rewrite one app's env.js and invalidate CloudFront (beta):
aws lambda invoke --function-name CodeBuildEnvConfigLambdaBeta \
  --cli-binary-format raw-in-base64-out \
  --payload '{"app":"hub"}' response.json
```

Function names per stage: `CodeBuildEnvConfigLambda{Beta,Gamma,Prod}`.

## Verifying an infrastructure change

A `lib/portal/infra/**` change deploys to all three stages, so confirm the blast radius before merge.
Adding an app should **add** resources and rename or remove **none**:

```sh
pnpm test
git stash && pnpm cdk synth -q -o /tmp/before && git stash pop
pnpm cdk synth -q -o /tmp/after
diff -r /tmp/before /tmp/after   # ignore *.metadata.json, tree.json, *.dot
```

A rename or removal of a logical ID is the dangerous signal — several buckets use fixed physical names
with `RemovalPolicy.DESTROY`, so a renamed construct ID deletes live data. See
[`docs/portal/README.md`](portal/README.md#deployed-names-that-no-longer-match).

## Inspecting a single stage

The per-stage hosting stacks are nested inside the infrastructure pipeline. You can synth/diff one
directly for inspection (you rarely deploy one by hand — the pipeline does that):

```sh
pnpm cdk synth  OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack
pnpm cdk diff   OrcaUIInfrastructurePipeline/DeploymentPipeline/OrcaBusBeta/OrcaUIInfrastructureStack
```

## Prerequisites

- Node.js 22 and Corepack (`corepack enable && pnpm install --frozen-lockfile`).
- AWS credentials for the toolchain account, with the CDK bootstrap roles, to deploy any pipeline
  stack. Cross-account deploys into beta/gamma/prod are performed by the pipelines, not from your
  machine.
- For a first-ever deploy, the `CrossDeploymentArtifactBucket` stack must already exist in the
  toolchain account (a prerequisite of the shared `DeploymentStackPipeline` construct).
