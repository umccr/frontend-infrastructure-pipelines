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
- The only intended difference is in `OrcaUIInfrastructurePipeline` (the self-mutating `OrcaBus-OrcaUIInfrastructure`
  CodePipeline):
  - source repository `orca-ui` → `frontend-infrastructure-pipelines`
  - trigger file paths `deploy/**` → shared files + `lib/orcaui/**`
  - synth/test commands run from the repository root instead of `--cwd deploy`

## Blockers to resolve before cutover

1. **GitHub owner.** `DeploymentStackPipeline` from `@orcabus/platform-cdk-constructs` always sources from
   `OrcaBus/<githubRepo>`. This repository is `umccr/frontend-infrastructure-pipelines`, so the pipeline currently
   synthesizes a source of `OrcaBus/frontend-infrastructure-pipelines`, which does not exist. Resolve by either:
   - adding a GitHub owner prop upstream in `platform-cdk-constructs`, then setting it to `umccr` in
     [`lib/orcaui/infrastructure-deployment-stack.ts`](../lib/orcaui/infrastructure-deployment-stack.ts); or
   - moving this repository into the `OrcaBus` organisation.
2. **CodeStar connection access.** The connection referenced by the `codestar_github_arn` SSM parameter in the
   toolchain account must be able to read this repository. If the repository stays in `umccr`, the connection's
   GitHub App must be installed on the `umccr` organisation with access to it.

## Cutover steps

Run these from the repository root with credentials for the toolchain account (`383856791668`).

1. Merge this repository's `init` branch into `main`.
2. Freeze changes to `deploy/` in `orca-ui`. From here until step 5, no PR touching `deploy/**` should merge there,
   or the old pipeline could self-mutate back to the `orca-ui` source.
3. Check parity:

   ```sh
   yarn install --immutable
   yarn test
   yarn cdk diff OrcaUIAppPipeline OrcaUIV2AppPipeline   # expect: no differences
   yarn cdk diff OrcaUIInfrastructurePipeline            # expect: only source, trigger and buildspec changes
   ```

4. Switch the infrastructure pipeline to this repository (one-time manual deploy):

   ```sh
   yarn cdk deploy OrcaUIInfrastructurePipeline
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

After deletion, do the same from a checkout of `OrcaBus/orca-ui@3933ce5`.
