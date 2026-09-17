import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { HUB_APP } from '../portal/apps';
import { PortalAppPipeline } from '../portal/app-pipeline';

/**
 * CI/CD for Hub (`umccr/hub`), served at `portal.<stage>.umccr.org/hub/`.
 *
 * Hosting (bucket, CloudFront behaviour, DNS, `env.js`) belongs to the shared portal stack in
 * `lib/portal/`; `HUB_APP` in `lib/portal/apps.ts` is its registry entry and decides which stages
 * exist. Currently beta and prod, with no gamma.
 *
 * Requires in `umccr/hub`: the bundler's base path set to `/hub/` (Vite `base: '/hub/'`), otherwise
 * the built asset URLs point at the site root and resolve against OrcaUI's bucket.
 */
export class HubAppPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    new PortalAppPipeline(this, 'HubAppPipeline', {
      app: HUB_APP,
      namePrefix: 'Hub',
      buildCommands: ['pnpm build'],
      // React SPA build output. Its contents are synced to s3://<bucket>/hub/.
      artifactBaseDirectory: 'build/',
    });
  }
}
