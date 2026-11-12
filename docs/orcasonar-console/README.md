# OrcaSonar Console — portal frontend at `/orcasonar/`

Context for how the OrcaSonar Console (`umccr/orcasonar-console`) is served on the shared portal and
what it relies on there. The console is a Vite SPA: usage and the audit log for
[OrcaSonar](https://github.com/umccr/orcasonar), UMCCR's documentation assistant, and playgrounds for its
chat and search. It is a client of OrcaSonar's API and has no backend of its own.

## How it fits the portal

The console is hosted as static files on S3 behind the portal's CloudFront distribution, under the
`/orcasonar/` path prefix, alongside OrcaUI (`/`), OrcaUI v2 (`/v2/`), Hub (`/hub/`) and OrcaHouse
(`/orcahouse/`). Its pipeline (`OrcaSonarConsoleAppCICDPipeline`) builds once and promotes the same
artifact from beta to prod, so nothing stage-specific is baked into the build.

It is hosted in **beta and prod only**. OrcaSonar itself runs in dev (`sonar.dev.umccr.org`) and prod
(`sonar.prod.umccr.org`), with no staging stage, so a gamma console would have no API to call. That puts
it in `GAMMA_GAP_APPS`, for a different reason from Hub and OrcaHouse.

## What the console does to fit

- **Base path.** Vite `base: '/orcasonar/'` and the router's basename match `pathPrefix`. The built
  `index.html` loads `/orcasonar/env.js` and `/orcasonar/favicon.svg`; assets are under
  `/orcasonar/assets/`.
- **Runtime config from `env.js`, key by key.** It reads `VITE_REGION`, `VITE_COG_USER_POOL_ID`,
  `VITE_COG_APP_CLIENT_ID` and `VITE_OAUTH_DOMAIN` from `window.config`, the same payload every portal
  app gets, so sign-in is shared with the other apps. On a deployed host, a missing key is reported on
  the page rather than leaving the console unable to sign in.
- **Sign-in returns to the console.** The OAuth redirect is `window.location.origin` + `/orcasonar/`,
  never `VITE_OAUTH_REDIRECT_IN`/`_OUT`, which name the portal root.
- **The API comes from the host.** `portal.dev.umccr.org` calls `sonar.dev.umccr.org`;
  `portal.umccr.org` calls `sonar.prod.umccr.org`. No API URL is in `env.js`.
- **One canonical host per stage.** OrcaSonar's CORS and the Cognito callbacks name
  `portal.dev.umccr.org` and `portal.umccr.org`, so the console moves a reader who arrives on
  `orcaui.*` or `portal.prod.umccr.org` to the canonical host first, as OrcaUI v2 does.

## Prerequisites, in order

1. **A buildable console on `main`.** The pipeline builds `umccr/orcasonar-console` `main` and runs
   `corepack install` and `pnpm install --frozen-lockfile` before `pnpm build`, so `main` needs the
   app's `package.json` and `pnpm-lock.yaml`. Until
   [umccr/orcasonar-console#1](https://github.com/umccr/orcasonar-console/pull/1) merges, `main` holds
   only a README and every build fails at install. The registry keeps `main` on purpose: pointing it
   at a feature branch would ship unreviewed code to prod and need a second change to undo.
2. **Cognito callbacks.** `/orcasonar/` in `portal_app_paths` of `umccr/infrastructure`
   `cognito_aai`, applied to an environment **before** the console reaches it, or sign-in fails with
   `redirect_mismatch`. See [`docs/cognito-aai/`](../cognito-aai/README.md).
3. **OrcaSonar's API.** The console uses `/audit/conversations` and `/chat/history`, so OrcaSonar must
   be deployed with them in that stage. OrcaSonar's authorizer already accepts the portal's
   `orcaui-app-<stage>` client, and its CORS allows the canonical portal hosts.
4. **Source access.** The `codestar_github_arn` connection's GitHub app must be able to read
   `umccr/orcasonar-console`, or the pipeline's Source stage fails.

## Pipeline stack

[`lib/portal/orcasonar/app-pipeline-stack.ts`](../../lib/portal/orcasonar/app-pipeline-stack.ts) defines
`OrcaSonarConsoleAppPipelineStack`, a thin configuration of the shared
[`PortalAppPipeline`](../../lib/portal/infra/app-pipeline.ts):

```ts
new PortalAppPipeline(this, 'OrcaSonarConsoleAppPipeline', {
  app: ORCASONAR_APP, // registry entry in lib/portal/infra/apps.ts
  namePrefix: 'OrcaSonarConsole', // apart from OrcaSonar's own UMCCR-OrcaSonar* pipelines
  buildCommands: ['pnpm build'],
  artifactBaseDirectory: 'build/', // Vite output, synced to s3://<bucket>/orcasonar/
});
```

Hosting (S3 bucket, CloudFront behaviour, `env.js`) is **not** defined here. It belongs to the shared
portal infrastructure; the console's registry entry is `ORCASONAR_APP` in
[`lib/portal/infra/apps.ts`](../../lib/portal/infra/apps.ts).

## Deploying

1. Merge the registry entry. The infrastructure pipeline deploys the console's bucket, the
   `/orcasonar/*` behaviour, its SPA rewrite entry and its `env.js` target to beta, then to prod after
   the approval. The origin stays empty until the app pipeline runs.
2. Once the console is on `main` (prerequisite 1), deploy the app pipeline from the toolchain account.
   CodePipeline runs a newly created pipeline once straight away and that run cannot be turned off,
   so this first deploy is also the first release. Deploying it earlier only gives a failed build,
   since nothing reaches a bucket, but it leaves the pipeline red until the next push.

   ```sh
   pnpm cdk diff OrcaSonarConsoleAppPipeline
   pnpm cdk deploy OrcaSonarConsoleAppPipeline
   ```

3. Later releases: merge to `umccr/orcasonar-console` `main`, or
   `aws codepipeline start-pipeline-execution --name OrcaSonarConsoleAppCICDPipeline`. Beta deploys
   first; prod waits for the approval.

Check a stage with `curl -s https://portal.dev.umccr.org/orcasonar/env.js`, and that
`curl -sI https://portal.dev.umccr.org/orcasonar` answers `302` with `location: /orcasonar/`. Then
sign in at `https://portal.dev.umccr.org/orcasonar/`.

## Related

- `umccr/orcasonar-console` — the app, with its own local development against OrcaSonar dev.
- `umccr/orcasonar` — the API the console calls, at `sonar.<stage>.umccr.org`.
- `umccr/infrastructure` `cognito_aai` — the `/orcasonar/` callback URLs. **Apply before the console
  deploys.**
