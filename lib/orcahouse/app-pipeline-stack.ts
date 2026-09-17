import { Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { ORCAHOUSE_APP } from '../portal/apps';
import { PortalAppPipeline } from '../portal/app-pipeline';

/**
 * CI/CD for OrcaHouse (`umccr/orcahouse-ui`), served at
 * `portal.<stage>.umccr.org/orcahouse/`.
 *
 * Hosting (bucket, CloudFront behaviour, DNS, `env.js`) belongs to the shared portal stack in
 * `lib/portal/`; `ORCAHOUSE_APP` in `lib/portal/apps.ts` is its registry entry and decides which
 * stages exist. Currently beta and prod, with no gamma.
 *
 * ## Required Next.js configuration in `umccr/orcahouse-ui`
 *
 * OrcaHouse is served as static files from S3, so its Next.js build must be a static export. The
 * default `pnpm build` output, `.next/`, is a build cache and **cannot** be served from S3: it has
 * no `index.html` at its top level. `next.config` needs:
 *
 * ```js
 * const nextConfig = {
 *   output: 'export',              // emit a static site into out/
 *   trailingSlash: true,           // export each route as <route>/index.html
 *   basePath: '/orcahouse',        // served under /orcahouse/, not the site root
 *   assetPrefix: '/orcahouse',
 *   images: { unoptimized: true }, // the Image Optimization API needs a server
 * };
 * ```
 *
 * `output: 'export'` rules out SSR, API routes, middleware and ISR. If OrcaHouse needs any of them,
 * it cannot be hosted on the portal distribution as-is and needs a server runtime instead.
 *
 * `trailingSlash: true` is what makes `clientRouting: 'static-export'` correct: the CloudFront
 * rewrite maps `/orcahouse/a/b` to `/orcahouse/a/b/index.html`. Without it the export emits
 * `a/b.html` and every deep link 404s.
 */
export class OrcaHouseAppPipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    new PortalAppPipeline(this, 'OrcaHouseAppPipeline', {
      app: ORCAHOUSE_APP,
      namePrefix: 'OrcaHouse',
      buildCommands: ['pnpm build'],
      // Next.js static export output, NOT .next/. See the class comment above.
      artifactBaseDirectory: 'out/',
      // App Router static exports emit .txt RSC payloads alongside each index.html. They are
      // fetched by stable name during client-side navigation, so they must not cache immutably.
      additionalNeverCacheGlobs: ['*.txt'],
    });
  }
}
