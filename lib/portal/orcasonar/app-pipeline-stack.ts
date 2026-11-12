import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ORCASONAR_APP } from '../infra/apps';
import { PortalAppPipeline } from '../infra/app-pipeline';

/**
 * CI/CD for the OrcaSonar Console (`umccr/orcasonar-console`), served at
 * `portal.<stage>.umccr.org/orcasonar/`.
 *
 * Hosting (bucket, CloudFront behaviour, DNS, `env.js`) belongs to the shared portal stack in
 * `lib/portal/infra/`; `ORCASONAR_APP` in `lib/portal/infra/apps.ts` is its registry entry and
 * decides which stages exist. Beta and prod, with no gamma, since OrcaSonar has no staging stage.
 *
 * Requires in `umccr/orcasonar-console`: Vite `base: '/orcasonar/'`, otherwise the built asset URLs
 * point at the site root and resolve against OrcaUI's bucket. Names are prefixed `OrcaSonarConsole`
 * to keep them apart from OrcaSonar's own pipelines (`UMCCR-OrcaSonar*`) in the toolchain account.
 */
export class OrcaSonarConsoleAppPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    new PortalAppPipeline(this, 'OrcaSonarConsoleAppPipeline', {
      app: ORCASONAR_APP,
      namePrefix: 'OrcaSonarConsole',
      buildCommands: ['pnpm build'],
      // Vite SPA build output (`build.outDir: 'build'`). Its contents are synced to
      // s3://<bucket>/orcasonar/.
      artifactBaseDirectory: 'build/',
    });
  }
}
