# Repository layout

```text
.
├── bin/app.ts                  # CDK entrypoint; registers every stack
├── lib/
│   ├── common/                 # Org-wide constants (accounts, region, stages)
│   └── portal/                 # Everything for portal.<stage>.umccr.org
│       ├── infra/              # Shared hosting infrastructure:
│       │   ├── apps.ts         #   the app registry (which app is on which path)
│       │   ├── config.ts       #   per-stage hosting config (domains, Lambda names, env vars)
│       │   ├── app-pipeline.ts #   reusable PortalAppPipeline construct
│       │   ├── infrastructure-stack.ts             # buckets, CloudFront, Route 53, env config Lambda
│       │   ├── infrastructure-deployment-stack.ts  # self-mutating pipeline that deploys the above
│       │   └── lambda/         #   env config Lambda + SPA rewrite CloudFront function
│       ├── orcaui/             # One folder per frontend: app CI/CD pipeline stacks only
│       ├── hub/
│       └── orcahouse/
├── test/
│   ├── common/                 # Shared test helpers (cdk-nag)
│   └── portal/                 # Tests mirror lib/portal/
└── docs/
    ├── portal/                 # Hosting model, routing, runtime config, future improvements
    ├── orcaui/, hub/, orcahouse-ui/, cognito-aai/   # Per-frontend runbooks and design notes
    ├── repository-layout.md    # This file
    └── adding-a-new-frontend.md
```

The split matters: **`lib/portal/infra/` owns hosting, `lib/portal/<frontend>/` owns building and
shipping.** A new frontend adds an entry to
[`lib/portal/infra/apps.ts`](../lib/portal/infra/apps.ts) and a pipeline stack under
`lib/portal/<frontend>/`; it does not get its own CloudFront distribution or DNS record.

Only `lib/portal/infra/**` triggers the shared infrastructure pipeline. The per-app folders
(`lib/portal/orcaui/**`, `lib/portal/hub/**`, ...) hold app CI/CD pipeline stacks that are deployed
separately, so an app pipeline change does not redeploy shared hosting. See
`PORTAL_INFRASTRUCTURE_FILE_PATHS` in
[`lib/portal/infra/infrastructure-deployment-stack.ts`](../lib/portal/infra/infrastructure-deployment-stack.ts).
