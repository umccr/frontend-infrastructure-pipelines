# Adding a new frontend

There are two ways a new frontend can be hosted from this repo, and they are very different in cost.
Pick the right one first.

|                        | Portal app                                                                              | New domain                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Example URL            | `portal.umccr.org/docs/`                                                                | `docs.umccr.org`                                                                         |
| What it adds           | a path prefix, one S3 bucket, one CloudFront behaviour on the **existing** distribution | a **new** CloudFront distribution, ACM cert, Route 53 record, and a new hosting stack    |
| Shared with other apps | domain, distribution, Cognito session (single sign-on), env config Lambda               | nothing by default — its own origin, its own session                                     |
| Effort                 | a registry entry + a small pipeline stack                                               | a new infrastructure stack, DNS/cert wiring, and its own pipeline                        |
| Use when               | it is part of the UMCCR portal and should share sign-in                                 | it needs its own domain, a separate trust boundary, or must not share the portal session |

**Default to a portal app.** Reach for a new domain only when a separate hostname or a separate
sign-in/trust boundary is an actual requirement. A new domain means a user is not automatically signed
in across it, and it carries its own certificate, DNS and distribution to operate.

---

## Portal app (the common case)

Served at `portal.<stage>.umccr.org/<prefix>/` on the shared distribution. The **app repo** side —
base path, artifact directory, routing mode, `env.js`, caching — is in
[`docs/portal/onboarding-an-app.md`](portal/onboarding-an-app.md). The infrastructure side, in this
repo, is:

1. Add a `PortalApp` entry to [`lib/portal/infra/apps.ts`](../lib/portal/infra/apps.ts) with its
   `pathPrefix` and per-stage bucket names. Leave a stage's bucket `undefined` to skip it, which is
   how a new app rolls out beta first. The hosting stack derives everything else from that entry: the
   S3 bucket, the `/<prefix>/*` CloudFront behaviour, the SPA rewrite allowlist and the `env.js`
   target. There is no second place to register a prefix.
2. Create `lib/portal/<frontend>/app-pipeline-stack.ts` using the shared
   [`PortalAppPipeline`](../lib/portal/infra/app-pipeline.ts) construct, which handles source, build,
   per-stage deploy, caching and the env config Lambda invoke.
   [`lib/portal/hub/`](../lib/portal/hub/) is a minimal example.
3. Register the pipeline stack in [`bin/app.ts`](../bin/app.ts), tagged with `umccr-org:Stack` and
   `umccr-org:Product`.
4. Pick names that are unique across the whole account. CloudFormation stack IDs, CodePipeline names,
   CodeBuild project names, Lambda function names and S3 bucket names all share one namespace with
   OrcaUI's existing resources. Prefix them with the frontend name.
5. Add tests under `test/portal/` (including cdk-nag checks) and docs under `docs/<frontend>/`.
6. Promote to gamma and prod by adding those stages to `bucketName`.

Register the callback URL for the new prefix on the Cognito app client
(`umccr/infrastructure` `cognito_aai`, [`docs/cognito-aai/`](cognito-aai/README.md)) **before** the
app deploys to an environment, or sign-in is rejected with `redirect_mismatch`.

### Blast radius

Step 1 changes `lib/portal/infra/**` and so triggers the shared infrastructure pipeline
(`PORTAL_INFRASTRUCTURE_FILE_PATHS` in
[`lib/portal/infra/infrastructure-deployment-stack.ts`](../lib/portal/infra/infrastructure-deployment-stack.ts)),
which redeploys hosting for **every** frontend. Steps 2 and 3 do not: app pipeline stacks live under
`lib/portal/<frontend>/`, are deployed manually, and are not self-mutating.

Before merging a `lib/portal/infra/**` change, confirm the blast radius with a template diff: adding
an app should add resources and rename or remove none. See
[`docs/deploying.md`](deploying.md#verifying-an-infrastructure-change).

---

## New domain (e.g. `docs.umccr.org`)

A new domain is its own hosting stack, not a change to the portal registry. The portal machinery
(path-based CloudFront behaviours, the SPA-rewrite route table, the shared session) does not apply,
because the whole point of a separate domain is a separate origin and trust boundary.

This is a larger change; plan it as a small project rather than a registry edit.

### What it requires

1. **A new folder, `lib/<domain>/`**, mirroring the portal's split: hosting infrastructure and a
   deployment pipeline. It does **not** live under `lib/portal/`, which is specifically the shared
   `portal.<stage>.umccr.org` distribution. Import shared account/region/stage constants from
   [`lib/common/config.ts`](../lib/common/config.ts).
2. **Its own CloudFront distribution and S3 origin.** You can reuse the patterns in
   [`lib/portal/infra/infrastructure-stack.ts`](../lib/portal/infra/infrastructure-stack.ts) — private
   S3 origin via OAI, HTTPS-only, a viewer-request rewrite function for client-side routing — but as a
   standalone distribution, not an added behaviour on the portal one.
3. **An ACM certificate in `us-east-1`** for the new hostname (CloudFront requires `us-east-1` certs),
   and a **Route 53 A/AAAA alias** for `docs.<stage>.umccr.org` to the distribution, in the UMCCR
   hosted zone. The portal reads the zone and a shared cert from SSM
   (`/hosted_zone/umccr/*`, `/orcaui/certificate_arn`); a new domain needs its **own** cert covering
   its hostname.
4. **Runtime config and auth, decided explicitly.** A separate domain is a separate browser origin, so
   it does **not** share the portal's Cognito session. If it needs sign-in, it needs its own Cognito
   app client and callback URLs (`umccr/infrastructure` `cognito_aai`), or a deliberate decision to be
   public. Do not assume the portal's `env.js` / SSO carries over — it does not.
5. **Its own deployment pipeline**, either the shared
   [`DeploymentStackPipeline`](../lib/portal/infra/infrastructure-deployment-stack.ts) construct (as
   the portal infra pipeline uses) for a self-mutating infra pipeline, or a `PortalAppPipeline`-style
   build-and-deploy pipeline if the content is built from a separate app repo. Give it its own trigger
   file paths (`lib/<domain>/**` plus shared files) so portal changes don't start it and vice versa.
6. **Register its stacks in [`bin/app.ts`](../bin/app.ts)** and add tests under `test/<domain>/`.

### Naming and safety

Same account-wide uniqueness rule as portal apps: stack IDs, pipeline names, CodeBuild project names,
Lambda function names and bucket names share one namespace — prefix everything with the domain name.
Never reuse a portal construct ID; and as everywhere in this repo, do not rename a deployed stack or
construct ID without a migration plan, because several resources use fixed physical names with
`RemovalPolicy.DESTROY`.

### Deploying

A new-domain infra pipeline behaves like the portal one — self-mutating, deploys per stage. See
[`docs/deploying.md`](deploying.md) for the infra-vs-app pipeline model and the deploy commands; the
same mechanics apply to a new domain's stacks.
