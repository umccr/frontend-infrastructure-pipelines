# Migration from `OrcaBus/orca-ui` `deploy/`

The OrcaUI hosting infrastructure and CI/CD pipelines used to live in the `deploy/` directory of
[`OrcaBus/orca-ui`](https://github.com/OrcaBus/orca-ui). They were moved here so every UMCCR frontend can be deployed
from one repository.

## What was moved

- Imported from `OrcaBus/orca-ui@3933ce5` with `git subtree split --prefix=deploy`, so `git log` / `git blame` keep
  the original history.
- Restructured into `bin/`, `lib/common/`, per-app pipeline folders and `docs/`. The OrcaUI pipeline
  stacks now live under `lib/portal/orcaui/`, with shared hosting in `lib/portal/infra/` and tests in
  `test/portal/`. (At migration time these were `lib/orcaui/` and `test/orcaui/`, before the portal
  refactor generalised the layout for Hub and OrcaHouse.)
- **Stack IDs and construct IDs are unchanged.** `cdk synth` output is byte-identical to the legacy app for:
  - `OrcaUIAppPipeline`
  - `OrcaUIV2AppPipeline`
  - `OrcaBus{Beta,Gamma,Prod}-OrcaUIInfrastructureStack` (templates and asset hashes)
- The only intended differences are in `OrcaUIInfrastructurePipeline` (the self-mutating `OrcaBus-OrcaUIInfrastructure`
  CodePipeline):
  - source repository `OrcaBus/orca-ui` → `umccr/frontend-infrastructure-pipelines`
  - trigger file paths `deploy/**` → shared files + `lib/portal/infra/**`
  - synth/test commands run from the repository root instead of `--cwd deploy`, and use pnpm instead of Yarn
    (`pnpm install --frozen-lockfile`, `pnpm cdk synth`, `pnpm run test`)

  The app pipelines (`OrcaUIAppPipeline`, `OrcaUIV2AppPipeline`) are unchanged: they still source `OrcaBus/orca-ui`
  and `OrcaBus/orca-ui-v2` and build those repos with their own package managers (Yarn for `orca-ui`, pnpm for
  `orca-ui-v2`). The move to pnpm applies only to this repository's own tooling and the infrastructure pipeline.

## Blockers to resolve before cutover

- [x] **GitHub owner. (Done.)** `DeploymentStackPipeline` used to hardcode the `OrcaBus/<githubRepo>` source owner.
      As of `@orcabus/platform-cdk-constructs@1.9.8` it accepts a `githubOwner` prop (default `OrcaBus`), and
      [`lib/portal/infra/infrastructure-deployment-stack.ts`](../lib/portal/infra/infrastructure-deployment-stack.ts) sets
      `githubOwner: 'umccr'`. The pipeline now synthesizes a source of `umccr/frontend-infrastructure-pipelines`. No
      further action is needed here unless the repository moves organisations.
- [x] **CodeStar connection access. (Done.)** The connection referenced by the `codestar_github_arn` SSM parameter in
      the toolchain account can read `umccr/frontend-infrastructure-pipelines`; the connection's GitHub App is installed on
      the `umccr` organisation with access to this repository. Re-verify only if the connection or repository ownership
      changes: if the connection cannot read the repo, the pipeline's Source stage fails.

## Cutover steps

Run these from the repository root with credentials for the toolchain account (`383856791668`).

1. Merge this repository's `init` branch into `main`.
2. Freeze changes to `deploy/` in `orca-ui`. From here until step 6, no PR touching `deploy/**` should merge there,
   or the old pipeline could self-mutate back to the `orca-ui` source.
3. Check parity:

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm cdk diff OrcaUIAppPipeline OrcaUIV2AppPipeline   # expect: only the gamma OpenAPI type-check env-var catch-up (see below)
   pnpm cdk diff OrcaUIInfrastructurePipeline            # expect: only source owner (umccr), trigger paths and pnpm buildspec changes
   ```

   The app-pipeline diff is currently **not empty**, but the difference is expected and safe. It adds two environment
   variables (`VITE_SYSTEM_CATALOG_URL`, `VITE_DEPLOY_STATUS_URL`, both pointing at STG) to the gamma
   `OpenApiTSCheck` / `OrcaUIV2OpenApiTSCheck` CodeBuild projects. Those values already exist in
   [`lib/portal/infra/config.ts`](../lib/portal/infra/config.ts); the deployed app pipelines simply predate that config change, so
   this is config catch-up rather than a change introduced by the pnpm/dependency work. The affected CodeBuild project
   is the **gamma type-check gate only** — it validates types against the STG OpenAPI schema and never builds or
   uploads a production bundle. See the app-pipeline drift item in step 5.

   If the app-pipeline diff shows anything **other** than these two env vars (for example changes to install/build
   commands, S3 sync, Lambda invocation, IAM roles, stages, or triggers), stop and investigate before deploying.

4. Switch the infrastructure pipeline to this repository (one-time manual deploy):

   ```sh
   pnpm cdk deploy OrcaUIInfrastructurePipeline
   ```

   Release a pipeline run and confirm it goes green. Self-mutation should be a no-op, and the beta, gamma and prod
   `OrcaUIInfrastructureStack` deployments should report no changes.

5. Align the app pipelines with `config.ts` (app-pipeline drift — deferred).

   `cdk diff` on `OrcaUIAppPipeline` / `OrcaUIV2AppPipeline` shows the two-env-var catch-up described in step 3. This
   is **deferred** and will be deployed during an off-hours window (no active users) together with release testing,
   to keep the production page stable in the meantime.

   Deploying these stacks is low risk and does **not** release the page:
   - The app pipeline stacks are plain CodePipeline stacks and are **not self-mutating**. `cdk deploy` only updates the
     CloudFormation resources (the gamma type-check CodeBuild project's env vars); it does not start a pipeline
     execution.
   - A release only happens on a push to `OrcaBus/orca-ui` / `orca-ui-v2` `main`, or a manual "Release change".
   - Even on the next natural pipeline run, only the gamma type-check step is affected, and prod is gated behind a
     manual approval action.

   When ready (off-hours):

   ```sh
   pnpm cdk deploy OrcaUIAppPipeline OrcaUIV2AppPipeline
   ```

   Then do release testing: trigger a pipeline run (or wait for the next app push), confirm the gamma
   `TSCheckWithStgOpenAPI` step passes with the new env vars, promote through the manual approval, and verify the
   beta/gamma/prod pages load and serve the expected `env.js`.

6. In `orca-ui`, open a PR that:
   - deletes `deploy/`;
   - removes the `deploy/cdk.out` / `deploy/.gitignore` references from the `lint` and `prettier-*` scripts in
     `package.json`;
   - replaces `docs/ui-v2-deployment-strategy.md` with a link to
     [`docs/orcaui/ui-v2-deployment-strategy.md`](./orcaui/ui-v2-deployment-strategy.md) in this repository.

   This push won't start the app pipeline, because it still excludes `deploy/**`.

## Follow-ups after cutover

- Remove the legacy `Excludes: ['deploy/**']` trigger filter from
  [`app-pipeline-stack.ts`](../lib/portal/orcaui/app-pipeline-stack.ts) and
  [`v2-app-pipeline-stack.ts`](../lib/portal/orcaui/v2-app-pipeline-stack.ts), then deploy those stacks manually. The app
  pipeline stacks are not self-mutating.

## Rollback

Until `deploy/` is deleted from `orca-ui`, point the pipeline back at `orca-ui` by redeploying it from the legacy
code:

```sh
cd orca-ui/deploy
yarn install --immutable
yarn cdk deploy OrcaUIInfrastructurePipeline
```

These rollback commands intentionally use Yarn: they run against the legacy `orca-ui/deploy` code, which predates this
repository's move to pnpm.

After deletion, do the same from a checkout of `OrcaBus/orca-ui@3933ce5`.
