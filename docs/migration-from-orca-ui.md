# Migration from `OrcaBus/orca-ui` `deploy/`

The OrcaUI hosting infrastructure and CI/CD pipelines used to live in the `deploy/` directory of
[`OrcaBus/orca-ui`](https://github.com/OrcaBus/orca-ui). They were moved here so every UMCCR frontend can be deployed
from one repository.

## What was moved

- Imported from `OrcaBus/orca-ui@3933ce5` with `git subtree split --prefix=deploy`, so `git log` / `git blame` keep
  the original history.
- Restructured into `bin/`, `lib/common/`, `lib/orcaui/`, `test/orcaui/` and `docs/orcaui/`.
- **Stack IDs and construct IDs are unchanged.** `cdk synth` output is byte-identical to the legacy app for:
  - `OrcaUIAppPipeline`
  - `OrcaUIV2AppPipeline`
  - `OrcaBus{Beta,Gamma,Prod}-OrcaUIInfrastructureStack` (templates and asset hashes)
- The only intended differences are in `OrcaUIInfrastructurePipeline` (the self-mutating `OrcaBus-OrcaUIInfrastructure`
  CodePipeline):
  - source repository `OrcaBus/orca-ui` → `umccr/frontend-infrastructure-pipelines`
  - trigger file paths `deploy/**` → shared files + `lib/orcaui/**`
  - synth/test commands run from the repository root instead of `--cwd deploy`, and use pnpm instead of Yarn
    (`pnpm install --frozen-lockfile`, `pnpm cdk synth`, `pnpm run test`)

  The app pipelines (`OrcaUIAppPipeline`, `OrcaUIV2AppPipeline`) are unchanged: they still source `OrcaBus/orca-ui`
  and `OrcaBus/orca-ui-v2` and build those repos with their own package managers (Yarn for `orca-ui`, pnpm for
  `orca-ui-v2`). The move to pnpm applies only to this repository's own tooling and the infrastructure pipeline.

## Blockers to resolve before cutover

1. **GitHub owner. (Resolved.)** `DeploymentStackPipeline` used to hardcode the `OrcaBus/<githubRepo>` source owner.
   As of `@orcabus/platform-cdk-constructs@1.9.8` it accepts a `githubOwner` prop (default `OrcaBus`), and
   [`lib/orcaui/infrastructure-deployment-stack.ts`](../lib/orcaui/infrastructure-deployment-stack.ts) sets
   `githubOwner: 'umccr'`. The pipeline now synthesizes a source of `umccr/frontend-infrastructure-pipelines`. No
   further action is needed here unless the repository moves organisations.
2. **CodeStar connection access.** The connection referenced by the `codestar_github_arn` SSM parameter in the
   toolchain account must be able to read this repository. Because the source is `umccr/frontend-infrastructure-pipelines`,
   the connection's GitHub App must be installed on the `umccr` organisation with access to this repository. This is the
   remaining blocker to verify before cutover: if the connection cannot read the repo, the pipeline's Source stage fails.

## Cutover steps

Run these from the repository root with credentials for the toolchain account (`383856791668`).

1. Merge this repository's `init` branch into `main`.
2. Freeze changes to `deploy/` in `orca-ui`. From here until step 5, no PR touching `deploy/**` should merge there,
   or the old pipeline could self-mutate back to the `orca-ui` source.
3. Check parity:

   ```sh
   pnpm install --frozen-lockfile
   pnpm test
   pnpm cdk diff OrcaUIAppPipeline OrcaUIV2AppPipeline   # expect: no differences
   pnpm cdk diff OrcaUIInfrastructurePipeline            # expect: only source owner (umccr), trigger paths and pnpm buildspec changes
   ```

   If the app-pipeline diff is not empty, stop and investigate before deploying: the migration to pnpm and the
   dependency bumps are only intended to change this repository's tooling and the infrastructure pipeline, not the
   app pipelines. Asset-hash-only differences are acceptable; resource or configuration changes are not.

4. Switch the infrastructure pipeline to this repository (one-time manual deploy):

   ```sh
   pnpm cdk deploy OrcaUIInfrastructurePipeline
   ```

   Release a pipeline run and confirm it goes green. Self-mutation should be a no-op, and the beta, gamma and prod
   `OrcaUIInfrastructureStack` deployments should report no changes.

5. In `orca-ui`, open a PR that:
   - deletes `deploy/`;
   - removes the `deploy/cdk.out` / `deploy/.gitignore` references from the `lint` and `prettier-*` scripts in
     `package.json`;
   - replaces `docs/ui-v2-deployment-strategy.md` with a link to
     [`docs/orcaui/ui-v2-deployment-strategy.md`](./orcaui/ui-v2-deployment-strategy.md) in this repository.

   This push won't start the app pipeline, because it still excludes `deploy/**`.

## Follow-ups after cutover

- Remove the legacy `Excludes: ['deploy/**']` trigger filter from
  [`app-pipeline-stack.ts`](../lib/orcaui/app-pipeline-stack.ts) and
  [`v2-app-pipeline-stack.ts`](../lib/orcaui/v2-app-pipeline-stack.ts), then deploy those stacks manually. The app
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
